<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
  import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

  GlobalWorkerOptions.workerSrc = workerUrl;

  type PdfPageView = {
    number: number;
    dataUrl: string;
    text: string;
    width: number;
    height: number;
  };

  export let url = "";
  export let query = "";

  let containerEl: HTMLDivElement | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let resizeTimer: number | undefined;
  let renderToken = 0;
  let renderWidth = 0;
  let loading = false;
  let error = "";
  let pages: PdfPageView[] = [];
  let lastScrollSignature = "";

  const MIN_PAGE_WIDTH = 320;

  function queryTerms(value: string): string[] {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return [];
    return [...new Set(normalized.split(/\s+/).map((term) => term.trim()).filter((term) => term.length >= 2))];
  }

  function textMatchesQuery(text: string, terms: string[]): boolean {
    if (terms.length === 0) return false;
    const haystack = text.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  }

  function matchExcerpt(text: string, terms: string[]): string {
    if (!text || terms.length === 0) {
      return "";
    }

    const haystack = text.toLowerCase();
    const firstIndex = terms
      .map((term) => haystack.indexOf(term))
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0];

    if (firstIndex === undefined) {
      return "";
    }

    const start = Math.max(0, firstIndex - 72);
    const end = Math.min(text.length, firstIndex + 160);
    const prefix = start > 0 ? "…" : "";
    const suffix = end < text.length ? "…" : "";
    return `${prefix}${text.slice(start, end).trim()}${suffix}`;
  }

  function availableWidth(): number {
    return Math.max((containerEl?.clientWidth ?? 0) - 24, MIN_PAGE_WIDTH);
  }

  function scheduleRender(delay = 0): void {
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
    lastScrollSignature = "";

    try {
      const loadingTask = getDocument(url);
      const pdf = await loadingTask.promise;

      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        if (token !== renderToken) {
          break;
        }

        const page = await pdf.getPage(pageNumber);
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
        const pageText = textContent.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();

        pages = [
          ...pages,
          {
            number: pageNumber,
            dataUrl: canvas.toDataURL("image/png"),
            text: pageText,
            width: scaledViewport.width,
            height: scaledViewport.height,
          },
        ];

        page.cleanup();
      }

      await pdf.destroy();
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

  async function scrollToFirstMatch(pageNumber: number): Promise<void> {
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

  $: terms = queryTerms(query);
  $: matchedPageNumbers = new Set(
    pages.filter((page) => textMatchesQuery(page.text, terms)).map((page) => page.number),
  );
  $: firstMatchedPage = pages.find((page) => matchedPageNumbers.has(page.number))?.number ?? null;
  $: if (containerEl && url) {
    scheduleRender();
  }
  $: if (!url) {
    pages = [];
    loading = false;
    error = "";
  }
  $: {
    const signature = `${url}::${terms.join(" ")}`;
    if (firstMatchedPage && signature !== lastScrollSignature) {
      lastScrollSignature = signature;
      void scrollToFirstMatch(firstMatchedPage);
    }
  }
  $: if (containerEl && !resizeObserver) {
    resizeObserver = new ResizeObserver(() => {
      const nextWidth = availableWidth();
      if (Math.abs(nextWidth - renderWidth) > 24) {
        scheduleRender(120);
      }
    });
    resizeObserver.observe(containerEl);
  }

  onDestroy(() => {
    renderToken += 1;
    if (resizeTimer) {
      window.clearTimeout(resizeTimer);
    }
    resizeObserver?.disconnect();
    resizeObserver = null;
  });
</script>

<div bind:this={containerEl} class="pdf-document">
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
      {#each pages as page}
        <figure
          class:pdf-document__page--match={matchedPageNumbers.has(page.number)}
          class="pdf-document__page"
          data-page-number={page.number}
        >
          {#if matchedPageNumbers.has(page.number)}
            <figcaption class="pdf-document__match-badge">
              <strong>Zoekmatch op pagina {page.number}</strong>
              <span>{matchExcerpt(page.text, terms)}</span>
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
        </figure>
      {/each}
    </div>
  {/if}
</div>
