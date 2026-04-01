<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
  import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

  GlobalWorkerOptions.workerSrc = workerUrl;

  type PdfPageView = {
    number: number;
    dataUrl: string;
    width: number;
    height: number;
    textItems: PdfTextItem[];
  };

  type PdfTextItem = {
    left: number;
    top: number;
    width: number;
    height: number;
    fontSize: number;
    text: string;
    html: string;
    hasMatch: boolean;
  };

  export let url = "";
  export let initialPage: number | null = null;
  export let query = "";
  export let matchPreview = "";

  let containerEl: HTMLDivElement | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let resizeTimer: number | undefined;
  let renderToken = 0;
  let renderWidth = 0;
  let loading = false;
  let error = "";
  let pages: PdfPageView[] = [];
  let pageCount = 0;
  let pdfDocument: Awaited<ReturnType<typeof getDocument>>["promise"] extends Promise<infer T> ? T : never | null =
    null;
  let lastScrollSignature = "";
  let loadingPrevious = false;
  let loadingNext = false;
  let scrollCheckTimer: number | undefined;

  const MIN_PAGE_WIDTH = 320;
  const SMALL_DOCUMENT_PAGE_LIMIT = 12;
  const PAGE_BATCH_SIZE = 5;

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

  function hasPreviousPages(): boolean {
    return visiblePageNumbers()[0] > 1;
  }

  function hasNextPages(): boolean {
    const visible = visiblePageNumbers();
    return visible.length > 0 && visible[visible.length - 1] < pageCount;
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
    const textItems = textContent.items
      .filter((item): item is {
        str: string;
        transform: number[];
        width: number;
        height: number;
      } => "str" in item && Array.isArray(item.transform))
      .map((item) => {
        const tx = item.transform[4] * scale;
        const ty = item.transform[5] * scale;
        const width = Math.max(item.width * scale, 1);
        const height = Math.max(item.height * scale, 1);
        const fontSize = Math.max(Math.abs(item.transform[0] || item.transform[3] || item.height) * scale, 8);
        const highlighted = highlightText(item.str);

        return {
          left: tx,
          top: scaledViewport.height - ty - height,
          width,
          height,
          fontSize,
          text: item.str,
          html: highlighted.html,
          hasMatch: highlighted.hasMatch,
        };
      })
      .filter((item) => item.text.trim().length > 0);

    const renderedPage = {
      number: pageNumber,
      dataUrl: canvas.toDataURL("image/png"),
      width: scaledViewport.width,
      height: scaledViewport.height,
      textItems,
    };

    page.cleanup();
    return renderedPage;
  }

  async function renderPageSet(pageNumbers: number[]): Promise<PdfPageView[]> {
    const uniqueNumbers = [...new Set(pageNumbers)].sort((left, right) => left - right);
    const rendered = await Promise.all(uniqueNumbers.map((pageNumber) => renderSinglePage(pageNumber)));
    return rendered.sort((left, right) => left.number - right.number);
  }

  function initialPageWindow(): number[] {
    if (pageCount <= SMALL_DOCUMENT_PAGE_LIMIT) {
      return Array.from({ length: pageCount }, (_, index) => index + 1);
    }

    const center = targetPageNumber();
    const start = Math.max(1, center - 1);
    const end = Math.min(pageCount, center + 1);
    const pages = [];
    for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
      pages.push(pageNumber);
    }
    return pages;
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

    renderWidth = nextWidth;
    const token = ++renderToken;
    loading = true;
    error = "";
    pages = [];
    pageCount = 0;
    lastScrollSignature = "";

    try {
      const loadingTask = getDocument(url);
      const pdf = await loadingTask.promise;
      if (token !== renderToken) {
        await pdf.destroy();
        return;
      }

      pdfDocument = pdf;
      pageCount = pdf.numPages;
      pages = await renderPageSet(initialPageWindow());
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

  async function ensurePageVisible(pageNumber: number): Promise<void> {
    if (!pdfDocument || pageNumber < 1 || pageNumber > pageCount) {
      return;
    }

    if (!visiblePageNumbers().includes(pageNumber)) {
      const nextPages = await renderPageSet([pageNumber - 1, pageNumber, pageNumber + 1].filter((value) =>
        value >= 1 && value <= pageCount
      ));
      pages = [...pages, ...nextPages]
        .sort((left, right) => left.number - right.number)
        .filter((page, index, list) => index === list.findIndex((item) => item.number === page.number));
    }

    await tick();
    const pageEl = containerEl?.querySelector<HTMLElement>(
      `.pdf-document__page[data-page-number="${pageNumber}"]`,
    );
    if (!pageEl) {
      return;
    }

    pageEl.scrollIntoView({
      block: "center",
      behavior: "smooth",
    });
  }

  async function loadPreviousPages(): Promise<void> {
    if (!pdfDocument || loadingPrevious) {
      return;
    }
    loadingPrevious = true;

    try {
      const first = visiblePageNumbers()[0] ?? 1;
      const start = Math.max(1, first - PAGE_BATCH_SIZE);
      const additions = Array.from({ length: first - start }, (_, index) => start + index);
      if (additions.length === 0) {
        return;
      }

      const anchorTop = containerEl?.scrollHeight ?? 0;
      const rendered = await renderPageSet(additions);
      pages = [...rendered, ...pages];
      await tick();
      if (containerEl) {
        const growth = containerEl.scrollHeight - anchorTop;
        containerEl.scrollTop += growth;
      }
    } finally {
      loadingPrevious = false;
    }
  }

  async function loadNextPages(): Promise<void> {
    if (!pdfDocument || loadingNext) {
      return;
    }
    loadingNext = true;

    try {
      const last = visiblePageNumbers().at(-1) ?? 0;
      const end = Math.min(pageCount, last + PAGE_BATCH_SIZE);
      const additions = Array.from({ length: end - last }, (_, index) => last + index + 1);
      if (additions.length === 0) {
        return;
      }

      const rendered = await renderPageSet(additions);
      pages = [...pages, ...rendered];
    } finally {
      loadingNext = false;
    }
  }

  function checkScrollPrefetch(): void {
    if (!containerEl || loading) {
      return;
    }

    const threshold = Math.max(320, containerEl.clientHeight * 0.8);
    const distanceFromTop = containerEl.scrollTop;
    const distanceFromBottom =
      containerEl.scrollHeight - containerEl.clientHeight - containerEl.scrollTop;

    if (distanceFromTop < threshold && hasPreviousPages()) {
      void loadPreviousPages();
    }

    if (distanceFromBottom < threshold && hasNextPages()) {
      void loadNextPages();
    }
  }

  function scheduleScrollCheck(): void {
    if (scrollCheckTimer) {
      window.clearTimeout(scrollCheckTimer);
    }

    scrollCheckTimer = window.setTimeout(() => {
      scrollCheckTimer = undefined;
      checkScrollPrefetch();
    }, 20);
  }

  $: if (containerEl && url) {
    void scheduleRender();
  }

  $: if (!url) {
    pages = [];
    pageCount = 0;
    pdfDocument = null;
    loading = false;
    error = "";
  }

  $: {
    const signature = `${url}::${initialPage ?? 1}`;
    if (pdfDocument && pageCount > 0 && signature !== lastScrollSignature) {
      lastScrollSignature = signature;
      void ensurePageVisible(targetPageNumber());
    }
  }

  $: if (pages.length > 0) {
    void tick().then(() => checkScrollPrefetch());
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
      {#if initialPage}
        <p class="pdf-document__location">PDF geopend rond pagina {initialPage}</p>
      {/if}

      {#if hasPreviousPages()}
        <div class="pdf-document__pager">
          <button class="ghost-button" type="button" on:click={loadPreviousPages}>
            Laad eerdere pagina's
          </button>
        </div>
      {/if}

      {#each pages as page}
        <figure
          class:pdf-document__page--match={page.number === initialPage}
          class="pdf-document__page"
          data-page-number={page.number}
        >
          {#if page.number === initialPage}
            <figcaption class="pdf-document__match-badge">
              <strong>Zoekmatch op pagina {page.number}</strong>
              {#if matchPreview}
                <span>{matchPreview}</span>
              {:else}
                <span>PDF opent direct bij de best passende pagina voor "{query}".</span>
              {/if}
            </figcaption>
          {/if}
          <img
            alt={`PDF pagina ${page.number}`}
            class="pdf-document__image"
            height={page.height}
            loading="lazy"
            src={page.dataUrl}
            width={page.width}
          />
          <div class="pdf-document__text-layer" aria-label={`Tekstlaag pagina ${page.number}`}>
            {#each page.textItems as item}
              <span
                class:pdf-document__text-item--match={item.hasMatch}
                class="pdf-document__text-item"
                style={`left:${item.left}px;top:${item.top}px;width:${item.width}px;height:${item.height}px;font-size:${item.fontSize}px;`}
              >
                {@html item.html}
              </span>
            {/each}
          </div>
        </figure>
      {/each}

      {#if hasNextPages()}
        <div class="pdf-document__pager">
          <span>Meer pagina's worden automatisch geladen tijdens scrollen.</span>
        </div>
      {/if}
    </div>
  {/if}
</div>
