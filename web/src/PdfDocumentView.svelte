<script lang="ts">
  import { createEventDispatcher, onDestroy, tick } from "svelte";

  export let url = "";
  export let initialPage: number | null = null;

  const dispatch = createEventDispatcher<{ pagechange: { page: number } }>();

  type PageEntry = {
    number: number;
    blobUrl: string | null;
    loading: boolean;
    error: boolean;
  };

  const PAGE_WINDOW_BEHIND = 2;
  const PAGE_WINDOW_AHEAD = 5;

  let containerEl: HTMLDivElement | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let scrollCheckTimer: number | undefined;
  let activePage = 0;
  let pageCount = 0;
  let windowPages: number[] = [];
  let pageEntries = new Map<number, PageEntry>();
  let pages: PageEntry[] = [];
  let loading = true;
  let error = "";
  let loadedUrl = "";
  let applyingWindow = false;
  let abortControllers = new Map<number, AbortController>();
  let lastScrollSignature = "";
  let pendingCenterPage = 0;
  let initializingTargetOnly = false;

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
    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
  }

  function pageLookahead(centerPage: number): number[] {
    const bounded = Math.max(1, pageCount > 0 ? Math.min(pageCount, centerPage) : centerPage);
    const start = Math.max(1, bounded - 1);
    const end = pageCount > 0 ? Math.min(pageCount, bounded + 2) : bounded + 2;
    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
  }

  function warmPages(pageNumbers: number[]): void {
    for (const pageNum of pageNumbers) {
      if (!pageEntries.has(pageNum) && !abortControllers.has(pageNum)) {
        void fetchPage(pageNum);
      }
    }
  }

  async function fetchPage(pageNumber: number): Promise<void> {
    const controller = new AbortController();
    abortControllers.set(pageNumber, controller);

    try {
      const response = await fetch(pageImageUrl(pageNumber), { signal: controller.signal });

      if (pageCount === 0 && response.ok) {
        const count = parseInt(response.headers.get("x-pdf-page-count") ?? "", 10);
        if (!isNaN(count) && count > 0) {
          pageCount = count;
          // Trim window pages that are now out of range
          const validWindow = windowPages.filter((n) => n <= pageCount);
          if (validWindow.length !== windowPages.length) {
            windowPages = validWindow;
          }
        }
      }

      if (!response.ok) {
        if (!windowPages.includes(pageNumber)) return;
        pageEntries.set(pageNumber, { number: pageNumber, blobUrl: null, loading: false, error: true });
        pages = windowPages.map((n) => pageEntries.get(n) ?? { number: n, blobUrl: null, loading: true, error: false });
        return;
      }

      const blob = await response.blob();
      if (!windowPages.includes(pageNumber)) {
        URL.revokeObjectURL(URL.createObjectURL(blob));
        return;
      }

      const blobUrl = URL.createObjectURL(blob);
      pageEntries.set(pageNumber, { number: pageNumber, blobUrl, loading: false, error: false });
      pages = windowPages.map((n) => pageEntries.get(n) ?? { number: n, blobUrl: null, loading: true, error: false });
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      if (!windowPages.includes(pageNumber)) return;
      pageEntries.set(pageNumber, { number: pageNumber, blobUrl: null, loading: false, error: true });
      pages = windowPages.map((n) => pageEntries.get(n) ?? { number: n, blobUrl: null, loading: true, error: false });
    } finally {
      abortControllers.delete(pageNumber);
    }
  }

  async function applyPageWindow(centerPage: number): Promise<void> {
    if (applyingWindow) return;
    applyingWindow = true;

    try {
      const nextWindow = pageWindow(centerPage);

      // Cancel and evict pages leaving the window
      for (const pageNum of windowPages) {
        if (!nextWindow.includes(pageNum)) {
          abortControllers.get(pageNum)?.abort();
          abortControllers.delete(pageNum);
          const entry = pageEntries.get(pageNum);
          if (entry?.blobUrl) URL.revokeObjectURL(entry.blobUrl);
          pageEntries.delete(pageNum);
        }
      }

      windowPages = nextWindow;

      // Start fetching pages not yet loaded
      warmPages(nextWindow);

      pages = windowPages.map((n) => pageEntries.get(n) ?? { number: n, blobUrl: null, loading: true, error: false });
    } finally {
      applyingWindow = false;
    }
  }

  async function ensurePageVisible(pageNumber: number, behavior: ScrollBehavior = "smooth"): Promise<void> {
    activePage = pageNumber;
    await tick();
    const pageEl = containerEl?.querySelector<HTMLElement>(`.pdf-document__page[data-page-number="${pageNumber}"]`);
    pageEl?.scrollIntoView({ block: "start", behavior });
  }

  async function expandAroundPagePreservingPosition(pageNumber: number): Promise<void> {
    if (!containerEl) return;

    const currentPageEl =
      containerEl.querySelector<HTMLElement>(`.pdf-document__page[data-page-number="${pageNumber}"]`);
    const previousTop = currentPageEl?.getBoundingClientRect().top ?? 0;

    windowPages = pageWindow(pageNumber);
    warmPages(windowPages);
    pages = windowPages.map((n) => pageEntries.get(n) ?? { number: n, blobUrl: null, loading: true, error: false });

    await tick();

    const nextPageEl =
      containerEl.querySelector<HTMLElement>(`.pdf-document__page[data-page-number="${pageNumber}"]`);
    if (!nextPageEl) return;

    const nextTop = nextPageEl.getBoundingClientRect().top;
    containerEl.scrollTop += nextTop - previousTop;
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
    windowPages = [];
    pages = [];
    pageEntries = new Map();
    abortControllers = new Map();
    lastScrollSignature = "";
    initializingTargetOnly = true;

    const targetPage = targetPageNumber();
    pendingCenterPage = targetPage;
    windowPages = [targetPage];
    pages = [{ number: targetPage, blobUrl: null, loading: true, error: false }];
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
    if (initializingTargetOnly) {
      initializingTargetOnly = false;
      void expandAroundPagePreservingPosition(pageNumber);
    }
  }

  function mostVisiblePageNumber(): number | null {
    if (!containerEl || windowPages.length === 0) return null;

    const containerRect = containerEl.getBoundingClientRect();
    const viewportCenter = containerRect.top + containerRect.height / 2;
    let bestPage: number | null = null;
    let bestDistance = Infinity;

    for (const pageNum of windowPages) {
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
    if (applyingWindow || pendingCenterPage > 0 || initializingTargetOnly) return;

    const nextVisiblePage = mostVisiblePageNumber();
    if (!nextVisiblePage || nextVisiblePage === activePage) return;

    activePage = nextVisiblePage;
    dispatch("pagechange", { page: nextVisiblePage });

    const desiredWindow = pageWindow(nextVisiblePage);
    if (desiredWindow.join(",") !== windowPages.join(",")) {
      await applyPageWindow(nextVisiblePage);
    }
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
    windowPages = [];
    pageEntries = new Map();
    abortControllers = new Map();
    pendingCenterPage = 0;
    initializingTargetOnly = false;
  }

  $: {
    const signature = `${url}::${initialPage ?? 1}`;
    if (loadedUrl === url && pageCount > 0 && signature !== lastScrollSignature) {
      lastScrollSignature = signature;
      const targetPage = targetPageNumber();
      warmPages(pageLookahead(targetPage));
      if (targetPage !== activePage || !windowPages.includes(targetPage)) {
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
            <div class="pdf-document__page-placeholder pdf-document__skeleton" aria-hidden="true"></div>
          {/if}
        </figure>
      {/each}
    </div>
  {/if}
</div>
