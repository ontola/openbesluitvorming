<script lang="ts">
  import { createEventDispatcher, onDestroy, tick } from "svelte";

  export let url = "";
  export let initialPage: number | null = null;

  const dispatch = createEventDispatcher<{ pagechange: { page: number; pageCount: number } }>();

  type PageEntry = {
    number: number;
    blobUrl: string | null;
    loading: boolean;
    error: boolean;
  };

  const PAGE_WINDOW_BEHIND = 2;
  const PAGE_WINDOW_AHEAD = 5;
  const PAGE_FETCH_BUFFER = 8;
  const PAGE_CACHE_BUFFER = 24;

  let containerEl: HTMLDivElement | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let scrollCheckTimer: number | undefined;
  let activePage = 0;
  let pageCount = 0;
  let pageEntries = new Map<number, PageEntry>();
  let pages: PageEntry[] = [];
  let loading = true;
  let error = "";
  let loadedUrl = "";
  let abortControllers = new Map<number, AbortController>();
  let lastScrollSignature = "";
  let pendingCenterPage = 0;

  function targetPageNumber(): number {
    const value = initialPage ?? 1;
    return Math.max(1, Math.min(pageCount || value, value));
  }

  function pageImageUrl(pageNumber: number): string {
    return `${url}/page/${pageNumber}`;
  }

  function pageWindow(centerPage: number): number[] {
    const bounded = Math.max(1, pageCount > 0 ? Math.min(pageCount, centerPage) : centerPage);
    const start = Math.max(1, bounded - PAGE_WINDOW_BEHIND);
    const end = pageCount > 0 ? Math.min(pageCount, bounded + PAGE_WINDOW_AHEAD) : bounded + PAGE_WINDOW_AHEAD;
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  }

  function pageLookahead(centerPage: number): number[] {
    const bounded = Math.max(1, pageCount > 0 ? Math.min(pageCount, centerPage) : centerPage);
    const start = Math.max(1, bounded - PAGE_FETCH_BUFFER);
    const end = pageCount > 0 ? Math.min(pageCount, bounded + PAGE_FETCH_BUFFER) : bounded + PAGE_FETCH_BUFFER;
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  }

  function pageCacheRange(centerPage: number): number[] {
    const bounded = Math.max(1, pageCount > 0 ? Math.min(pageCount, centerPage) : centerPage);
    const start = Math.max(1, bounded - PAGE_CACHE_BUFFER);
    const end = pageCount > 0 ? Math.min(pageCount, bounded + PAGE_CACHE_BUFFER) : bounded + PAGE_CACHE_BUFFER;
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  }

  function desiredPageNumbers(): number[] {
    if (pageCount > 0) {
      return Array.from({ length: pageCount }, (_, index) => index + 1);
    }
    return pendingCenterPage > 0 ? [pendingCenterPage] : [];
  }

  function syncPages(): void {
    pages = desiredPageNumbers().map((pageNumber) =>
      pageEntries.get(pageNumber) ?? {
        number: pageNumber,
        blobUrl: null,
        loading: pageNumber === pendingCenterPage || pageCount === 0,
        error: false,
      }
    );
  }

  function warmPages(pageNumbers: number[]): void {
    for (const pageNum of pageNumbers) {
      const entry = pageEntries.get(pageNum);
      if (abortControllers.has(pageNum) || entry?.blobUrl || entry?.loading) continue;
      void fetchPage(pageNum);
    }
  }

  async function fetchPage(pageNumber: number): Promise<void> {
    const existingEntry = pageEntries.get(pageNumber);
    pageEntries.set(pageNumber, {
      number: pageNumber,
      blobUrl: existingEntry?.blobUrl ?? null,
      loading: true,
      error: false,
    });
    syncPages();

    const controller = new AbortController();
    abortControllers.set(pageNumber, controller);

    try {
      const response = await fetch(pageImageUrl(pageNumber), { signal: controller.signal });

      if (pageCount === 0 && response.ok) {
        const count = parseInt(response.headers.get("x-pdf-page-count") ?? "", 10);
        if (!isNaN(count) && count > 0) {
          pageCount = count;
          dispatch("pagechange", { page: activePage || targetPageNumber(), pageCount });
          syncPages();
        }
      }

      if (!response.ok) {
        pageEntries.set(pageNumber, { number: pageNumber, blobUrl: null, loading: false, error: true });
        syncPages();
        return;
      }

      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const previousEntry = pageEntries.get(pageNumber);
      if (previousEntry?.blobUrl) {
        URL.revokeObjectURL(previousEntry.blobUrl);
      }
      pageEntries.set(pageNumber, { number: pageNumber, blobUrl, loading: false, error: false });
      syncPages();
    } catch (errorValue) {
      if (errorValue instanceof Error && errorValue.name === "AbortError") return;
      pageEntries.set(pageNumber, { number: pageNumber, blobUrl: null, loading: false, error: true });
      syncPages();
    } finally {
      abortControllers.delete(pageNumber);
    }
  }

  function trimPageCache(centerPage: number): void {
    const keepPages = new Set(pageCacheRange(centerPage));
    for (const [pageNumber, entry] of pageEntries.entries()) {
      if (keepPages.has(pageNumber) || pageNumber === pendingCenterPage) {
        continue;
      }
      abortControllers.get(pageNumber)?.abort();
      abortControllers.delete(pageNumber);
      if (entry.blobUrl) {
        URL.revokeObjectURL(entry.blobUrl);
      }
      pageEntries.delete(pageNumber);
    }
    syncPages();
  }

  async function ensurePageVisible(pageNumber: number, behavior: ScrollBehavior = "smooth"): Promise<void> {
    activePage = pageNumber;
    dispatch("pagechange", { page: pageNumber, pageCount });
    warmPages(pageLookahead(pageNumber));
    trimPageCache(pageNumber);

    await tick();
    const pageEl = containerEl?.querySelector<HTMLElement>(`.pdf-document__page[data-page-number="${pageNumber}"]`);
    pageEl?.scrollIntoView({ block: "start", behavior });
  }

  async function initialize(): Promise<void> {
    if (!url || !containerEl) return;

    for (const ctrl of abortControllers.values()) ctrl.abort();
    for (const entry of pageEntries.values()) {
      if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);
    }

    loading = true;
    error = "";
    loadedUrl = url;
    activePage = 0;
    pageCount = 0;
    pages = [];
    pageEntries = new Map();
    abortControllers = new Map();
    lastScrollSignature = "";

    const targetPage = targetPageNumber();
    pendingCenterPage = targetPage;
    syncPages();
    warmPages([targetPage]);
    loading = false;

    await tick();
    await ensurePageVisible(targetPage, "auto");
  }

  async function recenterOnLoadedPage(pageNumber: number): Promise<void> {
    if (pageNumber !== pendingCenterPage || !containerEl || loadedUrl !== url) return;
    pendingCenterPage = 0;
    await tick();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        void ensurePageVisible(pageNumber, "auto");
      });
    });
  }

  function mostVisiblePageNumber(): number | null {
    if (!containerEl || pages.length === 0) return null;

    const containerRect = containerEl.getBoundingClientRect();
    const viewportCenter = containerRect.top + containerRect.height / 2;
    let bestPage: number | null = null;
    let bestDistance = Infinity;

    for (const pageNum of desiredPageNumbers()) {
      const pageEl = containerEl.querySelector<HTMLElement>(`.pdf-document__page[data-page-number="${pageNum}"]`);
      if (!pageEl) continue;
      const rect = pageEl.getBoundingClientRect();
      const distance = Math.abs(rect.top + rect.height / 2 - viewportCenter);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestPage = pageNum;
      }
    }

    return bestPage;
  }

  async function checkScrollPrefetch(): Promise<void> {
    if (pendingCenterPage > 0) return;

    const nextVisiblePage = mostVisiblePageNumber();
    if (!nextVisiblePage || nextVisiblePage === activePage) return;

    activePage = nextVisiblePage;
    dispatch("pagechange", { page: nextVisiblePage, pageCount });
    warmPages(pageLookahead(nextVisiblePage));
    trimPageCache(nextVisiblePage);
  }

  function scheduleScrollCheck(): void {
    if (scrollCheckTimer) window.clearTimeout(scrollCheckTimer);
    scrollCheckTimer = window.setTimeout(() => {
      scrollCheckTimer = undefined;
      void checkScrollPrefetch();
    }, 20);
  }

  $: if (containerEl && url && url !== loadedUrl) {
    void initialize();
  }

  $: if (!url) {
    for (const ctrl of abortControllers.values()) ctrl.abort();
    for (const entry of pageEntries.values()) {
      if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);
    }
    pages = [];
    pageCount = 0;
    loadedUrl = "";
    loading = false;
    error = "";
    activePage = 0;
    pageEntries = new Map();
    abortControllers = new Map();
    pendingCenterPage = 0;
  }

  $: {
    const signature = `${url}::${initialPage ?? 1}`;
    if (loadedUrl === url && pageCount > 0 && signature !== lastScrollSignature) {
      lastScrollSignature = signature;
      const targetPage = targetPageNumber();
      warmPages(pageLookahead(targetPage));
      if (targetPage !== activePage) {
        void ensurePageVisible(targetPage);
      }
    }
  }

  $: if (containerEl && !resizeObserver) {
    resizeObserver = new ResizeObserver(() => void checkScrollPrefetch());
    resizeObserver.observe(containerEl);
  }

  onDestroy(() => {
    for (const ctrl of abortControllers.values()) ctrl.abort();
    for (const entry of pageEntries.values()) {
      if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);
    }
    resizeObserver?.disconnect();
    if (scrollCheckTimer) window.clearTimeout(scrollCheckTimer);
  });
</script>

<div bind:this={containerEl} class="pdf-document" on:scroll={scheduleScrollCheck} tabindex="-1">
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
          <div class="pdf-document__page-media">
            {#if page.blobUrl}
              <img
                alt={`PDF pagina ${page.number}`}
                class="pdf-document__image"
                on:load={() => void recenterOnLoadedPage(page.number)}
                src={page.blobUrl}
              />
            {:else if page.error}
              <div class="pdf-document__page-placeholder" aria-hidden="true"></div>
            {:else}
              <div class="pdf-document__page-placeholder pdf-document__page-placeholder--loading" aria-hidden="true"></div>
            {/if}
          </div>
        </figure>
      {/each}
    </div>
  {/if}
</div>
