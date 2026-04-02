<script lang="ts">
  import { createEventDispatcher, onDestroy, tick } from "svelte";
  import { getDocument, GlobalWorkerOptions, TextLayer } from "pdfjs-dist";
  import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
  import jbig2WasmUrl from "pdfjs-dist/wasm/jbig2.wasm?url";

  GlobalWorkerOptions.workerSrc = workerUrl;

  type PdfPageView = {
    number: number;
    dataUrl: string;
    width: number;
    height: number;
    scale: number;
    viewport: unknown;
    textContent: unknown;
  };

  export let url = "";
  export let initialPage: number | null = null;
  export let query = "";

  const dispatch = createEventDispatcher<{ pagechange: { page: number } }>();
  const wasmUrl = jbig2WasmUrl.slice(0, jbig2WasmUrl.lastIndexOf("/") + 1);

  let containerEl: HTMLDivElement | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let resizeTimer: number | undefined;
  let renderToken = 0;
  let renderWidth = 0;
  let loading = false;
  let error = "";
  let pages: PdfPageView[] = [];
  let pageCount = 0;
  let loadedUrl = "";
  let pdfDocument: Awaited<ReturnType<typeof getDocument>>["promise"] extends Promise<infer T> ? T : never | null =
    null;
  let lastScrollSignature = "";
  let scrollCheckTimer: number | undefined;
  let activePage = 0;
  let windowPages: number[] = [];
  let pageCache = new Map<number, PdfPageView>();
  let applyingWindow = false;

  const MIN_PAGE_WIDTH = 320;
  const PAGE_WINDOW_BEHIND = 2;
  const PAGE_WINDOW_AHEAD = 5;
  const textLayerTasks = new Map<number, { cancel: () => void }>();

  function escapeHtml(value: string): string {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  }

  function escapeRegex(value: string): string {
    return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function queryTerms(): string[] {
    const normalized = query.trim();
    if (!normalized) return [];
    return [...new Set(
      normalized
        .split(/\s+/)
        .map((term) => term.trim())
        .filter((term) => term.length >= 2),
    )].sort((left, right) => right.length - left.length);
  }

  function highlightText(value: string): { html: string; hasMatch: boolean } {
    const terms = queryTerms();
    if (terms.length === 0) {
      return { html: escapeHtml(value), hasMatch: false };
    }

    const pattern = new RegExp(`(${terms.map(escapeRegex).join("|")})`, "gi");
    let hasMatch = false;
    const html = escapeHtml(value).replace(pattern, (match) => {
      hasMatch = true;
      return `<mark>${escapeHtml(match)}</mark>`;
    });
    return { html, hasMatch };
  }

  function applyHighlightsToTextLayer(container: HTMLElement): void {
    const spans = container.querySelectorAll<HTMLElement>('span:not([role="img"])');
    for (const span of spans) {
      const rawText = span.dataset.rawText ?? span.textContent ?? "";
      span.dataset.rawText = rawText;
      if (!rawText.trim()) {
        span.textContent = rawText;
        continue;
      }

      const highlighted = highlightText(rawText);
      if (highlighted.hasMatch) {
        span.innerHTML = highlighted.html;
      } else {
        span.textContent = rawText;
      }
    }
  }

  function targetPageNumber(): number {
    const value = initialPage ?? 1;
    return Math.max(1, Math.min(pageCount || value, value));
  }

  function availableWidth(): number {
    return Math.max((containerEl?.clientWidth ?? 0) - 24, MIN_PAGE_WIDTH);
  }

  function visiblePageNumbers(): number[] {
    return pages.map((page) => page.number).sort((left, right) => left - right);
  }

  function pageWindow(centerPage: number): number[] {
    const boundedCenter = Math.max(1, Math.min(pageCount || centerPage, centerPage));
    const start = Math.max(1, boundedCenter - PAGE_WINDOW_BEHIND);
    const end = Math.min(pageCount, boundedCenter + PAGE_WINDOW_AHEAD);
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  }

  async function renderSinglePage(pageNumber: number): Promise<PdfPageView> {
    if (!pdfDocument) {
      throw new Error("PDF document is not loaded");
    }

    const page = await pdfDocument.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const scale = renderWidth / viewport.width;
    const scaledViewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new Error("Canvas kon niet worden aangemaakt");
    }

    const deviceScale = window.devicePixelRatio || 1;
    canvas.width = Math.floor(scaledViewport.width * deviceScale);
    canvas.height = Math.floor(scaledViewport.height * deviceScale);
    context.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, scaledViewport.width, scaledViewport.height);

    await page.render({
      canvasContext: context,
      viewport: scaledViewport,
    }).promise;

    const textContent = await page.getTextContent();

    const renderedPage = {
      number: pageNumber,
      dataUrl: canvas.toDataURL("image/png"),
      width: scaledViewport.width,
      height: scaledViewport.height,
      scale: scaledViewport.scale,
      viewport: scaledViewport,
      textContent,
    };

    page.cleanup();
    return renderedPage;
  }

  async function renderPageSet(pageNumbers: number[]): Promise<PdfPageView[]> {
    const uniqueNumbers = [...new Set(pageNumbers)].sort((left, right) => left - right);
    const rendered = await Promise.all(uniqueNumbers.map((pageNumber) => renderSinglePage(pageNumber)));
    return rendered.sort((left, right) => left.number - right.number);
  }

  async function scheduleRender(delay = 0): Promise<void> {
    if (resizeTimer) {
      window.clearTimeout(resizeTimer);
    }

    resizeTimer = window.setTimeout(() => {
      resizeTimer = undefined;
      void renderDocument();
    }, delay);
  }

  async function renderDocument(): Promise<void> {
    if (!url || !containerEl) {
      pages = [];
      pageCount = 0;
      pdfDocument = null;
      loading = false;
      error = "";
      return;
    }

    const nextWidth = availableWidth();
    if (nextWidth <= 0) {
      return;
    }

    if (pdfDocument && loadedUrl === url && pageCount > 0 && Math.abs(nextWidth - renderWidth) < 1) {
      return;
    }

    renderWidth = nextWidth;
    const token = ++renderToken;
    loading = true;
    error = "";
    pages = [];
    pageCount = 0;
    activePage = 0;
    windowPages = [];
    pageCache = new Map();
    lastScrollSignature = "";

    try {
      const loadingTask = getDocument({ url, wasmUrl });
      const pdf = await loadingTask.promise;
      if (token !== renderToken) {
        await pdf.destroy();
        return;
      }

      pdfDocument = pdf;
      loadedUrl = url;
      pageCount = pdf.numPages;
      const targetPage = targetPageNumber();
      activePage = 0;
      await applyPageWindow(targetPage);
      await ensurePageVisible(targetPage, "auto");
    } catch (cause) {
      if (token === renderToken) {
        console.error(cause);
        error = "PDF-weergave kon niet worden geladen.";
      }
    } finally {
      if (token === renderToken) {
        loading = false;
      }
    }
  }

  async function applyPageWindow(centerPage: number, preservePageNumber?: number): Promise<void> {
    if (!pdfDocument || centerPage < 1 || centerPage > pageCount || applyingWindow) {
      return;
    }

    applyingWindow = true;
    const nextWindow = pageWindow(centerPage);
    const preserveNumber = preservePageNumber ?? centerPage;
    const preserveSelector = `.pdf-document__page[data-page-number="${preserveNumber}"]`;
    const preserveEl = containerEl?.querySelector<HTMLElement>(preserveSelector) ?? null;
    const previousTop = preserveEl ? preserveEl.getBoundingClientRect().top : null;

    try {
      const missing = nextWindow.filter((pageNumber) => !pageCache.has(pageNumber));
      if (missing.length > 0) {
        const rendered = await renderPageSet(missing);
        for (const page of rendered) {
          pageCache.set(page.number, page);
        }
      }

      windowPages = nextWindow;
      pages = nextWindow
        .map((pageNumber) => pageCache.get(pageNumber))
        .filter((page): page is PdfPageView => Boolean(page));

      await tick();

      if (previousTop !== null) {
        const nextPreserveEl = containerEl?.querySelector<HTMLElement>(preserveSelector) ?? null;
        if (nextPreserveEl && containerEl) {
          const nextTop = nextPreserveEl.getBoundingClientRect().top;
          containerEl.scrollTop += nextTop - previousTop;
        }
      }
    } finally {
      applyingWindow = false;
    }
  }

  async function ensurePageVisible(pageNumber: number, behavior: ScrollBehavior = "smooth"): Promise<void> {
    if (!pdfDocument || pageNumber < 1 || pageNumber > pageCount) {
      return;
    }

    activePage = pageNumber;
    await applyPageWindow(pageNumber, pageNumber);
    await tick();
    const pageEl = containerEl?.querySelector<HTMLElement>(`.pdf-document__page[data-page-number="${pageNumber}"]`);
    if (!pageEl) {
      return;
    }

    pageEl.scrollIntoView({
      block: "center",
      behavior,
    });
  }

  function mostVisiblePageNumber(): number | null {
    if (!containerEl || pages.length === 0) {
      return null;
    }

    const containerRect = containerEl.getBoundingClientRect();
    const viewportCenter = containerRect.top + containerRect.height / 2;
    let bestPage: number | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const page of pages) {
      const pageEl = containerEl.querySelector<HTMLElement>(`.pdf-document__page[data-page-number="${page.number}"]`);
      if (!pageEl) {
        continue;
      }

      const rect = pageEl.getBoundingClientRect();
      const pageCenter = rect.top + rect.height / 2;
      const distance = Math.abs(pageCenter - viewportCenter);

      if (distance < bestDistance) {
        bestDistance = distance;
        bestPage = page.number;
      }
    }

    return bestPage;
  }

  async function checkScrollPrefetch(): Promise<void> {
    if (!containerEl || loading || applyingWindow) {
      return;
    }

    const nextVisiblePage = mostVisiblePageNumber();
    if (!nextVisiblePage || nextVisiblePage === activePage) {
      return;
    }

    activePage = nextVisiblePage;
    dispatch("pagechange", { page: nextVisiblePage });
    const desiredWindow = pageWindow(nextVisiblePage);
    if (desiredWindow.join(",") !== windowPages.join(",")) {
      await applyPageWindow(nextVisiblePage, nextVisiblePage);
    }
  }

  function scheduleScrollCheck(): void {
    if (scrollCheckTimer) {
      window.clearTimeout(scrollCheckTimer);
    }

    scrollCheckTimer = window.setTimeout(() => {
      scrollCheckTimer = undefined;
      void checkScrollPrefetch();
    }, 20);
  }

  function mountTextLayer(node: HTMLDivElement, page: PdfPageView): { update: (page: PdfPageView) => void; destroy: () => void } {
    let destroyed = false;
    let currentTask: { cancel: () => void } | null = null;

    async function renderLayer(nextPage: PdfPageView): Promise<void> {
      currentTask?.cancel();
      node.replaceChildren();
      node.classList.add("textLayer");
      node.style.setProperty("--scale-factor", `${nextPage.scale}`);
      node.style.setProperty("--user-unit", "1");
      node.style.setProperty("--total-scale-factor", `${nextPage.scale}`);

      const textLayer = new TextLayer({
        textContentSource: nextPage.textContent as never,
        container: node,
        viewport: nextPage.viewport as never,
      });

      currentTask = {
        cancel: () => textLayer.cancel(),
      };
      textLayerTasks.set(nextPage.number, currentTask);

      try {
        await textLayer.render();
        if (destroyed) {
          return;
        }
        applyHighlightsToTextLayer(node);
      } catch (cause) {
        if (!destroyed) {
          console.error(cause);
        }
      }
    }

    void renderLayer(page);

    return {
      update(nextPage) {
        void renderLayer(nextPage);
      },
      destroy() {
        destroyed = true;
        currentTask?.cancel();
        textLayerTasks.delete(page.number);
      },
    };
  }

  $: if (containerEl && url) {
    void scheduleRender();
  }

  $: if (!url) {
    pages = [];
    pageCount = 0;
    loadedUrl = "";
    pdfDocument = null;
    loading = false;
    error = "";
    activePage = 0;
    windowPages = [];
    pageCache = new Map();
  }

  $: {
    const signature = `${url}::${initialPage ?? 1}`;
    if (pdfDocument && pageCount > 0 && signature !== lastScrollSignature) {
      lastScrollSignature = signature;
      const targetPage = targetPageNumber();
      if (targetPage !== activePage || !visiblePageNumbers().includes(targetPage)) {
        void ensurePageVisible(targetPage);
      }
    }
  }

  $: if (pages.length >= 0) {
    void tick().then(() => {
      for (const page of pages) {
        const layer = containerEl?.querySelector<HTMLDivElement>(`.pdf-document__text-layer[data-page-number="${page.number}"]`);
        if (layer) {
          applyHighlightsToTextLayer(layer);
        }
      }
    });
  }

  $: if (containerEl && !resizeObserver) {
    resizeObserver = new ResizeObserver(() => {
      const nextWidth = availableWidth();
      if (Math.abs(nextWidth - renderWidth) > 24) {
        void scheduleRender(120);
      }
    });
    resizeObserver.observe(containerEl);
  }

  onDestroy(async () => {
    renderToken += 1;
    if (resizeTimer) {
      window.clearTimeout(resizeTimer);
    }
    if (scrollCheckTimer) {
      window.clearTimeout(scrollCheckTimer);
    }
    for (const task of textLayerTasks.values()) {
      task.cancel();
    }
    textLayerTasks.clear();
    resizeObserver?.disconnect();
    resizeObserver = null;
    await pdfDocument?.destroy();
    pdfDocument = null;
  });
</script>

<div bind:this={containerEl} class="pdf-document" on:scroll={scheduleScrollCheck}>
  {#if loading && pages.length === 0}
    <div class="pdf-document__loading" aria-hidden="true">
      <div class="pdf-document__skeleton"></div>
      <div class="pdf-document__skeleton"></div>
    </div>
  {:else if error}
    <p class="detail-sheet__pdf-fallback">
      {error}
      <a href={url} target="_blank" rel="noopener">Open PDF in nieuw tabblad</a>
    </p>
  {:else}
    <div class="pdf-document__pages">
      {#each pages as page (page.number)}
        <figure
          class:pdf-document__page--match={page.number === initialPage}
          class="pdf-document__page"
          data-page-number={page.number}
        >
          <img
            alt={`PDF pagina ${page.number}`}
            class="pdf-document__image"
            height={page.height}
            loading="lazy"
            src={page.dataUrl}
            width={page.width}
          />
          <div
            use:mountTextLayer={page}
            class="pdf-document__text-layer"
            data-page-number={page.number}
            aria-label={`Tekstlaag pagina ${page.number}`}
          ></div>
        </figure>
      {/each}
    </div>
  {/if}
</div>
