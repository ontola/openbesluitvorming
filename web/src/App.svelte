<script lang="ts">
  import { marked } from "marked";
  import { onDestroy, onMount, tick } from "svelte";
  import { fade, scale } from "svelte/transition";
  import type {
    AdminSourceOption,
    AdminSourcesResponse,
    EntityContentResponse,
    SearchResponse,
    SearchResult,
  } from "../../src/types.ts";
  import PdfDocumentView from "./PdfDocumentView.svelte";
  import SourcePicker from "./SourcePicker.svelte";

  type SearchRouteState = {
    query: string;
    organization: string;
    entityType: string;
    sort: string;
    dateFrom: string;
    dateTo: string;
    view: string;
    page: string;
  };

  function routeHasSearchIntent(state: SearchRouteState): boolean {
    return Boolean(
      state.query.trim() ||
        state.organization.trim() ||
        state.entityType.trim() ||
        state.dateFrom.trim() ||
        state.dateTo.trim() ||
        state.view.trim(),
    );
  }

  const initialRouteState = typeof window === "undefined"
    ? null
    : routeStateFromUrl(new URL(window.location.href));

  let query = "";
  let organization = "";
  let entityType = "";
  let sort = "date_desc";
  let dateFrom = "";
  let dateTo = "";
  let view = "";

  let sources: AdminSourceOption[] = [];
  let results: SearchResult[] = [];
  let totalCount: number | null = null;
  let totalIsApproximate = false;
  let hasMore = false;
  let loading = false;
  let loadingMore = false;
  let searched = initialRouteState ? routeHasSearchIntent(initialRouteState) : false;
  let filtersOpen = false;
  let searchRequestId = 0;

  let detailOpen = false;
  let detailLoading = false;
  let detailItem: SearchResult | null = null;
  let detailContent: EntityContentResponse | null = null;
  let detailMode: "text" | "pdf" = "text";
  let preferredDetailMode: "text" | "pdf" = "text";
  let detailPage = "";

  const detailCache = new Map<string, EntityContentResponse | null>();
  const detailRequests = new Map<string, Promise<EntityContentResponse | null>>();

  let queryInputEl: HTMLInputElement | null = null;
  let primarySearchFieldEl: HTMLLabelElement | null = null;
  let brandBlockEl: HTMLDivElement | null = null;
  let detailTextEl: HTMLElement | null = null;
  let loadMoreSentinelEl: HTMLDivElement | null = null;
  let debounceTimer: number | undefined;
  let loadMoreObserver: IntersectionObserver | null = null;
  let activeSearchSignature = "";
  let initialLoadingCardCount = 6;

  const PAGE_SIZE = 24;
  const DETAIL_MODE_STORAGE_KEY = "woozi.detailMode";
  const INITIAL_LOADING_CARD_MIN = 6;
  const INITIAL_LOADING_CARD_MAX = 12;
  const INITIAL_LOADING_CARD_HEIGHT = 210;

  function routeStateFromUrl(url: URL): SearchRouteState {
    return {
      query: url.searchParams.get("query") ?? "",
      organization: url.searchParams.get("organization") ?? "",
      entityType: url.searchParams.get("entityType") ?? "",
      sort: url.searchParams.get("sort") ?? "date_desc",
      dateFrom: url.searchParams.get("dateFrom") ?? "",
      dateTo: url.searchParams.get("dateTo") ?? "",
      view: url.searchParams.get("view") ?? "",
      page: url.searchParams.get("page") ?? "",
    };
  }

  function routeStateToSearchParams(state: SearchRouteState): URLSearchParams {
    const params = new URLSearchParams();
    if (state.query) params.set("query", state.query);
    if (state.organization) params.set("organization", state.organization);
    if (state.entityType) params.set("entityType", state.entityType);
    if (state.sort) params.set("sort", state.sort);
    if (state.dateFrom) params.set("dateFrom", state.dateFrom);
    if (state.dateTo) params.set("dateTo", state.dateTo);
    if (state.view) params.set("view", state.view);
    if (state.view && state.page) params.set("page", state.page);
    return params;
  }

  function currentRouteState(): SearchRouteState {
    return {
      query: query.trim(),
      organization: organization.trim(),
      entityType: entityType.trim(),
      sort: sort.trim() || "date_desc",
      dateFrom: dateFrom.trim(),
      dateTo: dateTo.trim(),
      view,
      page: view ? detailPage.trim() : "",
    };
  }

  function writeRouteState(mode: "push" | "replace" = "push"): void {
    const url = new URL(window.location.href);
    url.search = routeStateToSearchParams(currentRouteState()).toString();
    if (mode === "push") {
      window.history.pushState(null, "", url);
    } else {
      window.history.replaceState(null, "", url);
    }
  }

  function hasActiveSearchFilters(): boolean {
    return (
      query.trim().length > 0 ||
      organization.trim().length > 0 ||
      entityType.trim().length > 0 ||
      dateFrom.trim().length > 0 ||
      dateTo.trim().length > 0
    );
  }

  function hasAdvancedSearchFilters(): boolean {
    return (
      organization.trim().length > 0 ||
      entityType.trim().length > 0 ||
      dateFrom.trim().length > 0 ||
      dateTo.trim().length > 0
    );
  }

  function focusQuery(): void {
    window.setTimeout(() => {
      queryInputEl?.focus();
      queryInputEl?.select();
    }, 0);
  }

  function updateInitialLoadingCardCount(): void {
    const availableHeight = Math.max(window.innerHeight - 220, INITIAL_LOADING_CARD_HEIGHT * INITIAL_LOADING_CARD_MIN);
    const estimatedCount = Math.ceil(availableHeight / INITIAL_LOADING_CARD_HEIGHT);
    initialLoadingCardCount = Math.min(
      INITIAL_LOADING_CARD_MAX,
      Math.max(INITIAL_LOADING_CARD_MIN, estimatedCount),
    );
  }

  async function animateModeChange(apply: () => void): Promise<void> {
    const animatedElements = [brandBlockEl, primarySearchFieldEl].filter((element) => element !== null);
    const firstRects = animatedElements.map((element) => element.getBoundingClientRect());

    apply();
    await tick();

    animatedElements.forEach((element, index) => {
      const first = firstRects[index];
      const last = element.getBoundingClientRect();
      const deltaX = first.left - last.left;
      const deltaY = first.top - last.top;
      const scaleX = first.width > 0 && last.width > 0 ? first.width / last.width : 1;
      const scaleY = first.height > 0 && last.height > 0 ? first.height / last.height : 1;

      if (
        Math.abs(deltaX) < 0.5 &&
        Math.abs(deltaY) < 0.5 &&
        Math.abs(scaleX - 1) < 0.01 &&
        Math.abs(scaleY - 1) < 0.01
      ) {
        return;
      }

      element.animate(
        [
          {
            transformOrigin: "top left",
            transform: `translate(${deltaX}px, ${deltaY}px) scale(${scaleX}, ${scaleY})`,
          },
          {
            transformOrigin: "top left",
            transform: "translate(0, 0) scale(1, 1)",
          },
        ],
        {
          /** Should be the same as the motion-slow value in the CSS custom properties */
          duration: 500,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        },
      );
    });
  }

  async function clearToHome(mode: "push" | "replace" = "push"): Promise<void> {
    await animateModeChange(() => {
      query = "";
      organization = "";
      entityType = "";
      sort = "date_desc";
      dateFrom = "";
      dateTo = "";
      view = "";
      filtersOpen = false;
      searched = false;
      results = [];
      closeDetail(false);
      writeRouteState(mode);
    });
    focusQuery();
  }

  function entityPdfProxyUrl(entityId: string): string {
    return `/api/entities/${encodeURIComponent(entityId)}/pdf`;
  }

  function sanitizeMarkdownSource(markdown: string): string {
    return markdown.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  }

  function renderMarkdown(markdown?: string): string {
    if (!markdown?.trim()) {
      return "<p>Geen documenttekst beschikbaar.</p>";
    }

    return marked.parse(sanitizeMarkdownSource(markdown), {
      async: false,
      breaks: true,
      gfm: true,
    }) as string;
  }

  function loadPreferredDetailMode(): "text" | "pdf" {
    try {
      const stored = window.localStorage.getItem(DETAIL_MODE_STORAGE_KEY);
      return stored === "pdf" ? "pdf" : "text";
    } catch {
      return "text";
    }
  }

  function persistPreferredDetailMode(mode: "text" | "pdf"): void {
    preferredDetailMode = mode;
    try {
      window.localStorage.setItem(DETAIL_MODE_STORAGE_KEY, mode);
    } catch {
      // Ignore storage failures; the in-memory preference still works for this session.
    }
  }

  function escapeRegex(value: string): string {
    return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function getHighlightTerms(value: string): string[] {
    const normalized = value.trim();
    if (!normalized) return [];
    return [...new Set(
      normalized
        .split(/\s+/)
        .map((term) => term.trim())
        .filter((term) => term.length >= 2),
    )].sort((left, right) => right.length - left.length);
  }

  function highlightElementText(root: HTMLElement, value: string): void {
    const terms = getHighlightTerms(value);
    if (terms.length === 0) return;

    const pattern = new RegExp(`(${terms.map(escapeRegex).join("|")})`, "gi");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];

    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const parent = node.parentElement;
      if (!parent || parent.closest("mark, script, style")) continue;
      if (!node.nodeValue?.trim()) continue;
      nodes.push(node);
    }

    for (const node of nodes) {
      const text = node.nodeValue ?? "";
      pattern.lastIndex = 0;
      if (!pattern.test(text)) continue;

      pattern.lastIndex = 0;
      const fragment = document.createDocumentFragment();
      let lastIndex = 0;

      for (const match of text.matchAll(pattern)) {
        const index = match.index ?? 0;
        if (index > lastIndex) fragment.append(text.slice(lastIndex, index));
        const mark = document.createElement("mark");
        mark.textContent = match[0];
        fragment.appendChild(mark);
        lastIndex = index + match[0].length;
      }

      if (lastIndex < text.length) fragment.append(text.slice(lastIndex));
      node.parentNode?.replaceChild(fragment, node);
    }
  }

  async function fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url);
    const payload = (await response.json()) as T & { error?: string };
    if (!response.ok) {
      throw new Error(payload.error ?? "Verzoek mislukt");
    }
    return payload;
  }

  async function loadSources(): Promise<void> {
    const payload = await fetchJson<AdminSourcesResponse>("/api/sources?implemented=true");
    sources = (payload.sources ?? []).filter((source) => source.implemented);
  }

  function closeDetail(updateUrl = true): void {
    const closingEntityId = detailItem?.entityId ?? "";
    detailOpen = false;
    detailLoading = false;
    detailItem = null;
    detailContent = null;
    detailMode = "text";
    detailPage = "";
    document.body.classList.remove("body--locked");
    if (updateUrl && view) {
      view = "";
      writeRouteState();
    }

    if (closingEntityId) {
      window.setTimeout(() => {
        const card = document.querySelector<HTMLElement>(
          `.result-card[data-result-id="${CSS.escape(closingEntityId)}"]`,
        );
        if (!card) {
          return;
        }

        scrollResultCardIntoView(closingEntityId);
        card.classList.remove("result-card--returning");
        void card.offsetWidth;
        card.classList.add("result-card--returning");
        window.setTimeout(() => {
          card.classList.remove("result-card--returning");
        }, 1200);
      }, 40);
    }
  }

  function scrollResultCardIntoView(entityId: string): void {
    const card = document.querySelector<HTMLElement>(
      `.result-card[data-result-id="${CSS.escape(entityId)}"]`,
    );
    if (!card) {
      return;
    }

    card.scrollIntoView({
      block: "center",
      behavior: "smooth",
    });
  }

  function parsePageNumber(value: string): number | null {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  async function loadDetailContent(entityId: string): Promise<EntityContentResponse | null> {
    if (detailCache.has(entityId)) {
      return detailCache.get(entityId) ?? null;
    }

    const inFlight = detailRequests.get(entityId);
    if (inFlight) {
      return await inFlight;
    }

    const request = (async () => {
      const response = await fetch(`/api/entities/${encodeURIComponent(entityId)}`);
      if (response.status === 404) {
        detailCache.set(entityId, null);
        return null;
      }

      if (!response.ok) {
        throw new Error("Documentdetail kon niet worden geladen.");
      }

      const payload = (await response.json()) as EntityContentResponse;
      detailCache.set(entityId, payload);
      return payload;
    })();

    detailRequests.set(entityId, request);

    try {
      return await request;
    } finally {
      detailRequests.delete(entityId);
    }
  }

  async function prefetchDetailContent(entityId: string): Promise<void> {
    if (detailCache.has(entityId) || detailRequests.has(entityId)) {
      return;
    }

    try {
      await loadDetailContent(entityId);
    } catch {
      // Ignore prefetch failures; explicit opens should surface real errors.
    }
  }

  function prefetchAdjacentDetails(entityId: string): void {
    const currentIndex = results.findIndex((item) => item.entityId === entityId);
    if (currentIndex < 0) {
      return;
    }

    const previousItem = results[currentIndex - 1];
    const nextItem = results[currentIndex + 1];

    if (previousItem) {
      void prefetchDetailContent(previousItem.entityId);
    }

    if (nextItem) {
      void prefetchDetailContent(nextItem.entityId);
      return;
    }

    if (hasMore && !loadingMore) {
      const currentLength = results.length;
      void (async () => {
        await loadMoreResults();
        const appendedNextItem = results[currentLength];
        if (appendedNextItem) {
          await prefetchDetailContent(appendedNextItem.entityId);
        }
      })();
    }
  }

  async function syncDetailText(): Promise<void> {
    if (detailMode !== "text" || !detailTextEl) return;
    await tick();
    if (!detailTextEl) return;
    highlightElementText(detailTextEl, query);
    const firstMatch = detailTextEl.querySelector<HTMLElement>("mark");
    if (firstMatch) {
      detailTextEl.classList.remove("detail-sheet__text--highlighting");
      void detailTextEl.offsetWidth;
      detailTextEl.classList.add("detail-sheet__text--highlighting");
      firstMatch.scrollIntoView({ block: "center", behavior: "smooth" });
    } else {
      detailTextEl.classList.remove("detail-sheet__text--highlighting");
      detailTextEl.scrollTop = 0;
    }
  }

  async function openDetail(item: SearchResult, updateUrl = true, pageOverride: number | null = null): Promise<void> {
    detailItem = item;
    detailLoading = true;
    detailOpen = true;
    detailContent = null;
    detailMode = "text";
    detailPage = `${pageOverride ?? item.matchedPage ?? 1}`;
    document.body.classList.add("body--locked");
    scrollResultCardIntoView(item.entityId);

    if (updateUrl && view !== item.entityId) {
      view = item.entityId;
      writeRouteState();
    }

    const content = await loadDetailContent(item.entityId);
    if (view && view !== item.entityId) return;

    detailContent = content;
    detailLoading = false;
    const hasPdf = Boolean(content?.pdfUrl);
    detailMode = !content?.markdownText?.trim() && hasPdf
      ? "pdf"
      : preferredDetailMode === "pdf" && hasPdf
        ? "pdf"
        : "text";

    prefetchAdjacentDetails(item.entityId);

    if (detailMode === "text") {
      await syncDetailText();
    }
  }

  async function navigateDetail(direction: -1 | 1): Promise<void> {
    if (!detailItem) {
      return;
    }

    const currentIndex = results.findIndex((item) => item.entityId === detailItem?.entityId);
    if (currentIndex < 0) {
      return;
    }

    const targetIndex = currentIndex + direction;
    if (targetIndex >= 0 && targetIndex < results.length) {
      await openDetail(results[targetIndex]);
      return;
    }

    if (direction > 0 && hasMore && !loadingMore) {
      const previousLength = results.length;
      await loadMoreResults();
      if (results.length > previousLength) {
        const nextItem = results[previousLength];
        if (nextItem) {
          await openDetail(nextItem);
        }
      }
    }
  }

  function currentSearchSignature(): string {
    const { query, organization, entityType, sort, dateFrom, dateTo } = currentRouteState();
    return JSON.stringify({ query, organization, entityType, sort, dateFrom, dateTo });
  }

  async function fetchSearchPage(offset: number): Promise<SearchResponse> {
    const params = routeStateToSearchParams({ ...currentRouteState(), view: "" });
    params.set("offset", `${offset}`);
    params.set("limit", `${PAGE_SIZE}`);
    return await fetchJson<SearchResponse>(`/api/search?${params.toString()}`);
  }

  async function runSearch(mode: "push" | "replace" = "push"): Promise<void> {
    const hasFilters = hasActiveSearchFilters();

    if (!hasFilters) {
      results = [];
      totalCount = 0;
      totalIsApproximate = false;
      hasMore = false;
      activeSearchSignature = "";
      closeDetail(false);
      if (mode) writeRouteState(mode);
      return;
    }

    loading = true;
    loadingMore = false;
    if (mode) writeRouteState(mode);
    const requestId = ++searchRequestId;
    const signature = currentSearchSignature();
    activeSearchSignature = signature;

    try {
      const payload = await fetchSearchPage(0);
      if (requestId !== searchRequestId) return;
      results = payload.results ?? [];
      totalCount = payload.totalCount ?? null;
      totalIsApproximate = payload.totalIsApproximate ?? false;
      hasMore = payload.hasMore ?? false;

      if (view) {
        const selected = results.find((item) => item.entityId === view);
        if (selected) {
          await openDetail(selected, false, parsePageNumber(detailPage));
        } else {
          closeDetail(false);
        }
      } else {
        closeDetail(false);
      }
    } catch {
      if (requestId === searchRequestId) {
        results = [];
        totalCount = null;
        totalIsApproximate = false;
        hasMore = false;
      }
    } finally {
      if (requestId === searchRequestId) {
        loading = false;
      }
    }
  }

  async function loadMoreResults(): Promise<void> {
    if (!searched || loading || loadingMore || !hasMore) {
      return;
    }

    const signature = currentSearchSignature();
    if (signature !== activeSearchSignature) {
      return;
    }

    loadingMore = true;
    const requestId = searchRequestId;

    try {
      const payload = await fetchSearchPage(results.length);
      if (requestId !== searchRequestId || signature !== activeSearchSignature) {
        return;
      }

      const nextResults = payload.results ?? [];
      const seen = new Set(results.map((item) => item.entityId));
      results = [...results, ...nextResults.filter((item) => !seen.has(item.entityId))];
      totalCount = payload.totalCount ?? totalCount;
      totalIsApproximate = payload.totalIsApproximate ?? totalIsApproximate;
      hasMore = payload.hasMore ?? false;
    } finally {
      if (requestId === searchRequestId) {
        loadingMore = false;
      }
    }
  }

  function scheduleSearch(delayMs = 100): void {
    if (debounceTimer) window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      debounceTimer = undefined;
      void runSearch();
    }, delayMs);
  }

  function onQueryInput(): void {
    if (!searched) {
      return;
    }

    if (!query.trim()) {
      void runSearch("replace");
      return;
    }

    scheduleSearch();
  }

  async function onQuerySearch(): Promise<void> {
    if (!searched && !hasActiveSearchFilters()) {
      return;
    }

    if (!searched) {
      await animateModeChange(() => {
        searched = true;
      });
    }
    void runSearch("replace");
  }

  function onFilterChange(): void {
    if (debounceTimer) {
      window.clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }

    if (!searched) {
      return;
    }

    void runSearch();
  }

  function onSourceChange(event: CustomEvent<{ value: string }>): void {
    organization = event.detail.value;
    onFilterChange();
  }

  function applyState(state: SearchRouteState): void {
    query = state.query;
    organization = state.organization;
    entityType = state.entityType;
    sort = state.sort || "date_desc";
    dateFrom = state.dateFrom;
    dateTo = state.dateTo;
    view = state.view;
    detailPage = state.page;
    filtersOpen = hasAdvancedSearchFilters();
  }

  function handlePdfPageChange(event: CustomEvent<{ page: number }>): void {
    if (!detailOpen || !detailItem || detailMode !== "pdf") {
      return;
    }

    const nextPage = `${event.detail.page}`;
    if (detailPage === nextPage) {
      return;
    }

    detailPage = nextPage;
    writeRouteState("replace");
  }

  async function syncFromUrl(replace = false): Promise<void> {
    const nextState = routeStateFromUrl(new URL(window.location.href));
    applyState(nextState);

    if (!hasActiveSearchFilters() && !view) {
      searched = false;
      results = [];
      totalCount = null;
      totalIsApproximate = false;
      hasMore = false;
      activeSearchSignature = "";
      closeDetail(false);
      focusQuery();
      return;
    }

    searched = true;
    await runSearch(replace ? "replace" : "push");
  }

  function handlePopstate(): void {
    void syncFromUrl(true);
  }

  function handleEscape(event: KeyboardEvent): void {
    if (!detailOpen) {
      return;
    }

    if (event.key === "Escape") {
      closeDetail();
      return;
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      void navigateDetail(-1);
      return;
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      void navigateDetail(1);
    }
  }

  onMount(async () => {
    preferredDetailMode = loadPreferredDetailMode();
    updateInitialLoadingCardCount();
    await loadSources();
    await syncFromUrl(true);
    document.addEventListener("keydown", handleEscape);
    window.addEventListener("resize", updateInitialLoadingCardCount);
    loadMoreObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void loadMoreResults();
      }
    }, { rootMargin: "320px 0px" });
    if (!hasActiveSearchFilters() && !view) {
      focusQuery();
    }
  });

  onDestroy(() => {
    if (debounceTimer) {
      window.clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    document.removeEventListener("keydown", handleEscape);
    window.removeEventListener("resize", updateInitialLoadingCardCount);
    loadMoreObserver?.disconnect();
    loadMoreObserver = null;
  });

  $: {
    loadMoreObserver?.disconnect();
    if (loadMoreObserver && loadMoreSentinelEl && searched && hasMore) {
      loadMoreObserver.observe(loadMoreSentinelEl);
    }
  }

  $: if (detailOpen && detailMode === "text" && detailContent) {
    void syncDetailText();
  }

  $: initialResultsLoading = searched && loading && results.length === 0;
  $: resultsTitle = !searched
    ? "Zoek op organisatie of onderwerp"
    : loading
      ? "Zoeken..."
      : totalIsApproximate && totalCount !== null
        ? `Resultaten (~${totalCount})`
        : `Resultaten (${totalCount ?? results.length})`;
  $: selectedSource = sources.find((source) => source.key === organization) ?? null;
  $: detailIndex = detailItem ? results.findIndex((item) => item.entityId === detailItem.entityId) : -1;
  $: hasPreviousDetail = detailIndex > 0;
  $: hasNextDetail = detailIndex >= 0 && (detailIndex < results.length - 1 || hasMore);
  $: detailMarkdownHtml = renderMarkdown(detailContent?.markdownText);
  $: if (detailOpen && detailMode === "text" && detailContent && detailMarkdownHtml) {
    void syncDetailText();
  }
</script>

<svelte:window on:popstate={handlePopstate} />

<div class:page-shell--search={searched} class="page-shell">
  <header class:hero--search={searched} class="hero">
    <div class="hero__glow hero__glow--left"></div>
    <div class="hero__glow hero__glow--right"></div>
    <div class="hero__frame">
      <div class="hero__masthead">
        <p class="hero__admin-link"><a href="/admin.html">Admin</a></p>
        <div bind:this={brandBlockEl} class="hero__brand-block">
          <h1 class="brand">
            <a
              class="brand__link"
              href="/"
              on:click|preventDefault={() => {
                void clearToHome();
              }}
            >
              <span class="brand__dark">Open</span><span class="brand__light">Besluitvorming</span>
            </a>
          </h1>
          <p class="hero__intro">
            Vind vergaderingen, documenten en besluiten van Nederlandse overheden in een rustige,
            snelle zoekomgeving.
          </p>
          <ul class="hero__meta">
            <li><strong>5.153.921</strong> vergaderstukken</li>
            <li><strong>330+</strong> organisaties</li>
          </ul>
        </div>
      </div>

      <form
        class="search-panel"
        on:submit|preventDefault={() => {
          void runSearch();
        }}
      >
        <div class="search-panel__query-row">
          <label bind:this={primarySearchFieldEl} class="search-field search-field--primary">
            <input
              bind:this={queryInputEl}
              bind:value={query}
              name="query"
              type="search"
              placeholder="Zoeken naar documenten, vergaderingen, agenda's, besluiten..."
              autocomplete="off"
              on:input={onQueryInput}
              on:search={() => {
                void onQuerySearch();
              }}
            />
          </label>
          {#if searched}
            <button
              type="button"
              class="ghost-button ghost-button--subtle search-panel__toggle"
              aria-expanded={filtersOpen}
              on:click={() => {
                filtersOpen = !filtersOpen;
              }}
            >
              <span class="search-panel__toggle-icon" aria-hidden="true">⚙</span>
              <span class="search-panel__toggle-label">Meer instellingen</span>
            </button>
          {/if}
        </div>

        {#if searched && filtersOpen}
          <div class="search-panel__options">
            <SourcePicker
              options={sources}
              bind:value={organization}
              placeholder="Alle organisaties"
              valueSelector={(source) => source.key}
              on:change={onSourceChange}
            />

            <label class="select-field select-field--subtle select-field--compact">
              <span class="sr-only">Type resultaat</span>
              <select bind:value={entityType} name="entityType" on:change={onFilterChange}>
                <option value="">Alles</option>
                <option value="Document">Documenten</option>
                <option value="Meeting">Vergaderingen</option>
              </select>
            </label>

            <label class="search-field search-field--subtle search-field--compact">
              <span class="sr-only">Van datum</span>
              <input bind:value={dateFrom} name="dateFrom" type="date" on:change={onFilterChange} />
            </label>

            <label class="search-field search-field--subtle search-field--compact">
              <span class="sr-only">Tot datum</span>
              <input bind:value={dateTo} name="dateTo" type="date" on:change={onFilterChange} />
            </label>

            <label class="select-field select-field--subtle select-field--compact">
              <span class="sr-only">Sorteren</span>
              <select bind:value={sort} name="sort" on:change={() => void runSearch("replace")}>
                <option value="date_desc">Nieuwste eerst</option>
                <option value="date_asc">Oudste eerst</option>
                <option value="title_asc">Titel A-Z</option>
              </select>
            </label>
          </div>
        {/if}
      </form>
    </div>
  </header>

  {#if searched}
    <main class="content content--search" transition:fade={{ duration: 180 }}>
      <section class="search-results" aria-live="polite">
        <div class="search-results__heading">
          <div class="search-results__title-group">
            <h2 class="search-results__title">{resultsTitle}</h2>
          </div>
        </div>

        <div class:result-list--loading={loading} class="result-list" aria-busy={loading}>
          {#if initialResultsLoading}
            {#each Array.from({ length: initialLoadingCardCount }) as _, index}
              <article
                class="surface-card result-card result-card--skeleton"
                aria-hidden="true"
                style={`animation-delay:${index * 70}ms`}
              >
                <div class="result-card__meta">
                  <div class="result-card__tags">
                    <span class="pill pill--skeleton"></span>
                    <span class="pill pill--soft pill--skeleton"></span>
                  </div>
                  <span class="result-card__date result-card__line result-card__line--date"></span>
                </div>
                <span class="result-card__line result-card__line--title"></span>
                <span class="result-card__line result-card__line--body"></span>
                <span class="result-card__line result-card__line--body result-card__line--short"></span>
              </article>
            {/each}
          {:else if results.length === 0 && !loading}
            <div class="result-state">Geen resultaten gevonden voor deze zoekopdracht.</div>
          {:else}
            {#each results as item, index}
              <button
                type="button"
                class="surface-card surface-card--lift result-card"
                data-result-id={item.entityId}
                style={`animation-delay:${index * 70}ms`}
                on:click={() => void openDetail(item)}
                on:keydown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    void openDetail(item);
                  }
                }}
              >
                <div class="result-card__meta">
                  <div class="result-card__tags">
                    <span class="pill">{item.organization}</span>
                    <span class="pill pill--soft">{item.entityTypeLabel}</span>
                    {#if item.pageCount && item.entityType === "Document"}
                      <span class="pill pill--soft">{item.pageCount} pagina's</span>
                    {/if}
                  </div>
                  <span class="result-card__date">{item.date}</span>
                </div>
                <h3>{item.title}</h3>
                {#if item.summaryHtml}
                  <p>{@html item.summaryHtml}</p>
                {:else}
                  <p>{item.summary}</p>
                {/if}
              </button>
            {/each}

            {#if hasMore}
              <div bind:this={loadMoreSentinelEl} class="result-list__sentinel" aria-hidden="true">
                {#if loadingMore}Meer resultaten laden...{/if}
              </div>
            {/if}
          {/if}
        </div>
      </section>
    </main>
  {:else}
    <main class="content content--home" transition:fade={{ duration: 220 }}>
      <section class="section section--intro">
        <div class="section__heading">
          <p class="section__label">Waarom dit bestaat</p>
          <h2>Doorzoek besluitvorming zonder omwegen</h2>
        </div>
        <div class="prose">
          <p>
            OpenBesluitvorming brengt agenda&apos;s, vergaderingen, documenten en stemmingen samen
            in één zoekmachine. Niet als gesloten loket, maar als open infrastructuur die
            herbruikbaar is voor publieke verantwoording, journalistiek en lokaal bestuur.
          </p>
          <p>
            De nieuwe Woozi-architectuur zet bronextractie, events en zoekprojecties los van
            elkaar. Daardoor blijft de keten beheersbaar, ook als het aantal documenten fors
            groeit.
          </p>
        </div>
      </section>

      <section class="section section--cards">
        <div class="section__heading">
          <p class="section__label">Wat je hier ziet</p>
          <h2>Een eenvoudige startpagina voor publieke zoektoegang</h2>
        </div>
        <div class="feature-grid">
          <article class="surface-card feature-card">
            <h3>Snel zoeken</h3>
            <p>
              Eén zoekveld voor besluiten, agenda&apos;s, documenten en vergaderstukken. Gericht op
              publieke vindbaarheid, niet op intern beheer.
            </p>
          </article>
          <article class="surface-card feature-card">
            <h3>Open bronnen</h3>
            <p>
              Notubiz en andere leveranciers worden via extractors opgehaald, genormaliseerd en als
              herbruikbare events gepubliceerd.
            </p>
          </article>
          <article class="surface-card feature-card">
            <h3>Schaalbaar zoeken</h3>
            <p>
              Zoekdocumenten landen in Quickwit als projectie. De bron van waarheid blijft buiten
              de zoekindex.
            </p>
          </article>
        </div>
      </section>
    </main>
  {/if}
</div>

{#if detailOpen && detailItem}
  <section class="detail-overlay" transition:fade={{ duration: 160 }}>
    <button
      type="button"
      class="detail-overlay__backdrop"
      aria-label="Sluiten"
      on:click={() => closeDetail()}
    ></button>
    <div
      class="detail-sheet detail-sheet--reader"
      aria-modal="true"
      aria-labelledby="detail-title"
      role="dialog"
      in:scale={{ duration: 200, start: 0.97 }}
      out:scale={{ duration: 160, start: 0.985 }}
    >
      <div class="detail-sheet__header">
        <div class="detail-sheet__header-bar">
          <div class="detail-sheet__meta">
            <span class="pill">{detailItem.organization}</span>
            <span class="pill pill--soft">{detailItem.entityTypeLabel}</span>
            <span class="detail-sheet__date">{detailItem.date}</span>
          </div>

          <div class="detail-sheet__header-actions">
              {#if detailContent?.pdfUrl}
                <div class="detail-sheet__view-switch">
                  <button
                    type="button"
                    class="detail-sheet__view-toggle"
                    aria-pressed={detailMode === "text"}
                    on:click={async () => {
                      persistPreferredDetailMode("text");
                      detailMode = "text";
                      await syncDetailText();
                    }}
                  >
                    Tekst
                  </button>
                  <button
                    type="button"
                    class="detail-sheet__view-toggle"
                    aria-pressed={detailMode === "pdf"}
                    on:click={() => {
                      persistPreferredDetailMode("pdf");
                      detailMode = "pdf";
                    }}
                  >
                    PDF
                  </button>
                </div>
              {/if}
            <div class="detail-sheet__nav">
              <button
                type="button"
                class="ghost-button detail-sheet__nav-button"
                aria-label="Vorige resultaat"
                disabled={!hasPreviousDetail}
                on:click={() => {
                  void navigateDetail(-1);
                }}
              >
                ←
              </button>
              <button
                type="button"
                class="ghost-button detail-sheet__nav-button"
                aria-label="Volgende resultaat"
                disabled={!hasNextDetail}
                on:click={() => {
                  void navigateDetail(1);
                }}
              >
                →
              </button>
            </div>
            {#if detailContent?.downloadUrl || detailItem.downloadUrl}
              <a
                class="primary-button button-with-icon"
                href={detailContent?.downloadUrl ?? detailItem.downloadUrl}
                aria-label="Download"
                download
              >
                <span class="button-icon" aria-hidden="true">↓</span>
                <span class="button-label">Download</span>
              </a>
            {/if}
            <button
              class="ghost-button button-with-icon"
              type="button"
              aria-label="Sluiten"
              on:click={() => closeDetail()}
            >
              <span class="button-icon" aria-hidden="true">×</span>
              <span class="button-label">Sluiten</span>
            </button>
          </div>
        </div>

        <div class="detail-sheet__header-top">
          <h2 id="detail-title">{detailItem.title}</h2>
        </div>
      </div>

      <div class="detail-sheet__body">
        {#if detailMode === "text"}
          <div bind:this={detailTextEl} class="detail-sheet__text prose-detail">
            {#if detailLoading}
              <div class="detail-sheet__loading" aria-hidden="true">
                <span class="detail-sheet__loading-line detail-sheet__loading-line--title"></span>
                <span class="detail-sheet__loading-line"></span>
                <span class="detail-sheet__loading-line"></span>
                <span class="detail-sheet__loading-line detail-sheet__loading-line--short"></span>
                <span class="detail-sheet__loading-line"></span>
                <span class="detail-sheet__loading-line"></span>
                <span class="detail-sheet__loading-line detail-sheet__loading-line--medium"></span>
              </div>
            {:else}
              {@html detailMarkdownHtml}
            {/if}
          </div>
        {:else}
          <div class="detail-sheet__pdf">
            {#key detailItem.entityId}
              <PdfDocumentView
                initialPage={parsePageNumber(detailPage) ?? detailItem.matchedPage ?? null}
                matchPreview={detailItem.summary}
                on:pagechange={handlePdfPageChange}
                query={query}
                url={entityPdfProxyUrl(detailItem.entityId)}
              />
            {/key}
          </div>
        {/if}
      </div>
    </div>
  </section>
{/if}
