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
  import MeetingAgendaTree from "./MeetingAgendaTree.svelte";
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

  let homeOrgPickerOpen = false;
  let homeOrgPickerValue = "";
  /** Hero org picker instance while mounted; used to focus its input after opening. */
  let homeOrgPickerRef: SourcePicker | undefined;

  let sources: AdminSourceOption[] = [];
  let results: SearchResult[] = [];
  const fallbackDocumentCount = 7_058_862;
  const fallbackOrganizationCount = 321;
  let indexDocumentCount: number | null = null;
  let indexOrganizationCount: number | null = null;
  // Defaults used as pre-load fallback so the descriptive paragraph below
  // reads sensibly before /api/stats returns. Overwritten with live numbers.
  let indexMunicipalityCount = 300;
  let indexWaterBoardCount = 5;
  let indexProvinceCount = 7;
  let totalCount: number | null = null;
  let totalIsApproximate = false;
  let hasMore = false;
  let loading = false;
  let loadingMore = false;
  let searched = initialRouteState ? routeHasSearchIntent(initialRouteState) : false;
  let filtersOpen = false;
  let searchRequestId = 0;
  let searchAbortController: AbortController | null = null;

  const highPriorityPreviewCount = 3;

  let showApiDocs = false;
  let apiDocsHtml = "";

  async function openApiDocs() {
    if (!apiDocsHtml) {
      const res = await fetch("/API.md");
      const text = await res.text();
      apiDocsHtml = renderMarkdown(text);
    }
    showApiDocs = true;
  }

  let detailOpen = false;
  let detailLoading = false;
  let detailItem: SearchResult | null = null;
  let detailContent: EntityContentResponse | null = null;
  let detailMode: "text" | "pdf" = "text";
  let preferredDetailMode: "text" | "pdf" = "pdf";
  let detailPage = "";
  let detailPdfPageCount = 0;
  let detailPdfCurrentPage = 1;
  let detailPdfJumpOpen = false;
  let detailPdfJumpValue = "";

  const detailCache = new Map<string, EntityContentResponse | null>();
  const detailRequests = new Map<string, Promise<EntityContentResponse | null>>();

  let queryInputEl: HTMLInputElement | null = null;
  let primarySearchFieldEl: HTMLLabelElement | null = null;
  let brandBlockEl: HTMLDivElement | null = null;
  let detailDialogEl: HTMLDivElement | null = null;
  let detailTextEl: HTMLElement | null = null;
  let detailPdfEl: HTMLDivElement | null = null;
  let detailPdfJumpInputEl: HTMLInputElement | null = null;
  let loadMoreSentinelEl: HTMLDivElement | null = null;
  let debounceTimer: number | undefined;
  let loadMoreObserver: IntersectionObserver | null = null;
  let activeSearchSignature = "";
  let initialLoadingCardCount = 6;
  let loadedPreviewImages = new Set<string>();

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

  /** Public UI: dropdown line under org name (no supplier — internal detail). */
  function publicSourcePickerSubtitle(source: AdminSourceOption): string {
    return source.organizationType;
  }

  function previewLoadKey(item: SearchResult): string {
    return `${item.entityId}:${item.previewImageUrl ?? ""}`;
  }

  function previewImageLoading(index: number): "eager" | "lazy" {
    return index < highPriorityPreviewCount ? "eager" : "lazy";
  }

  function previewImageFetchPriority(index: number): "high" | "low" {
    return index < highPriorityPreviewCount ? "high" : "low";
  }

  function markPreviewLoaded(item: SearchResult): void {
    loadedPreviewImages = new Set([...loadedPreviewImages, previewLoadKey(item)]);
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
      return stored === "text" ? "text" : "pdf";
    } catch {
      return "pdf";
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

  function clearHighlightedText(root: HTMLElement): void {
    for (const mark of root.querySelectorAll("mark")) {
      const parent = mark.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark);
      parent.normalize();
    }
  }

  function highlightElementText(root: HTMLElement, value: string): void {
    clearHighlightedText(root);
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

  async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    const body = await response.text();
    let payload: (T & { error?: string }) | null = null;

    if (body) {
      try {
        payload = JSON.parse(body) as T & { error?: string };
      } catch {
        if (!response.ok) {
          throw new Error(body.trim() || `Verzoek mislukt (${response.status})`);
        }
        throw new Error("Ongeldige API-respons ontvangen.");
      }
    }

    if (!response.ok) {
      throw new Error(
        payload && typeof payload === "object" && "error" in payload && payload.error
          ? String(payload.error)
          : `Verzoek mislukt (${response.status})`,
      );
    }

    if (payload === null) {
      throw new Error("Lege API-respons ontvangen.");
    }

    return payload;
  }

  async function loadSources(): Promise<void> {
    const payload = await fetchJson<AdminSourcesResponse>("/api/sources?implemented=true");
    sources = (payload.sources ?? []).filter((source) => source.implemented && !source.isAggregate);
  }

  function closeDetail(updateUrl = true): void {
    const closingEntityId = detailItem?.entityId ?? "";
    detailOpen = false;
    detailLoading = false;
    detailItem = null;
    detailContent = null;
    detailMode = "text";
    detailPage = "";
    detailPdfPageCount = 0;
    detailPdfCurrentPage = 1;
    detailPdfJumpOpen = false;
    detailPdfJumpValue = "";
    if (updateUrl && view) {
      view = "";
      writeRouteState();
    }

    if (closingEntityId) {
      window.setTimeout(() => {
        restoreResultCardFocus(closingEntityId);
      }, 40);
    }
  }

  function resultCardForEntity(entityId: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(
      `.result-card[data-result-id="${CSS.escape(entityId)}"]`,
    );
  }

  function restoreResultCardFocus(entityId: string): void {
    const card = resultCardForEntity(entityId);
    if (!card) {
      return;
    }

    scrollResultCardIntoView(entityId);
    card.focus({ preventScroll: true });
    card.classList.remove("result-card--returning");
    void card.offsetWidth;
    card.classList.add("result-card--returning");
    window.setTimeout(() => {
      card.classList.remove("result-card--returning");
    }, 1200);
  }

  function scrollResultCardIntoView(entityId: string): void {
    const card = resultCardForEntity(entityId);
    if (!card) {
      return;
    }

    card.scrollIntoView({
      block: "center",
      behavior: "smooth",
    });
  }

  function activeDetailScrollContainer(): HTMLElement | null {
    if (!detailOpen) {
      return null;
    }

    if (detailMode === "pdf") {
      return detailPdfEl?.querySelector<HTMLElement>(".pdf-document") ?? detailPdfEl;
    }

    if (detailItem?.entityType === "Document") {
      return detailTextEl;
    }

    return detailDialogEl;
  }

  async function focusActiveDetailSurface(): Promise<void> {
    await tick();
    activeDetailScrollContainer()?.focus({ preventScroll: true });
  }

  function scrollActiveDetailContent(event: KeyboardEvent): boolean {
    const container = activeDetailScrollContainer();
    if (!container) {
      return false;
    }

    const pageStep = Math.max(120, Math.round(container.clientHeight * 0.85));
    const lineStep = 72;

    switch (event.key) {
      case "ArrowDown":
        container.scrollBy({ top: lineStep, behavior: "smooth" });
        return true;
      case "ArrowUp":
        container.scrollBy({ top: -lineStep, behavior: "smooth" });
        return true;
      case "PageDown":
      case " ":
        container.scrollBy({ top: pageStep, behavior: "smooth" });
        return true;
      case "PageUp":
        container.scrollBy({ top: -pageStep, behavior: "smooth" });
        return true;
      case "Home":
        container.scrollTo({ top: 0, behavior: "smooth" });
        return true;
      case "End":
        container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
        return true;
      default:
        return false;
    }
  }

  function isEditableKeyboardTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
      return false;
    }

    return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
  }

  function parsePageNumber(value: string): number | null {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  function currentDetailPdfPage(): number {
    return detailPdfCurrentPage;
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
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    if (!detailTextEl) return;
    highlightElementText(detailTextEl, query);
    const firstMatch = detailTextEl.querySelector<HTMLElement>("mark");
    if (firstMatch) {
      detailTextEl.classList.remove("detail-sheet__text--highlighting");
      void detailTextEl.offsetWidth;
      detailTextEl.classList.add("detail-sheet__text--highlighting");
      const containerRect = detailTextEl.getBoundingClientRect();
      const matchRect = firstMatch.getBoundingClientRect();
      const targetTop = detailTextEl.scrollTop + (matchRect.top - containerRect.top)
        - (detailTextEl.clientHeight / 2) + (matchRect.height / 2);
      detailTextEl.scrollTo({
        top: Math.max(0, targetTop),
        behavior: "smooth",
      });
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
    detailPdfPageCount = 0;
    detailPdfCurrentPage = parsePageNumber(detailPage) ?? 1;
    detailPdfJumpOpen = false;
    detailPdfJumpValue = "";
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

  function jumpToFirstPdfPage(): void {
    if (!detailOpen || detailMode !== "pdf") {
      return;
    }

    detailPdfJumpOpen = false;
    detailPdfJumpValue = "1";
    detailPage = "1";
    detailPdfCurrentPage = 1;
    writeRouteState("replace");
  }

  async function openPdfPageJump(): Promise<void> {
    if (!detailOpen || detailMode !== "pdf") {
      return;
    }

    detailPdfJumpOpen = true;
    detailPdfJumpValue = `${currentDetailPdfPage()}`;
    await tick();
    detailPdfJumpInputEl?.focus();
    detailPdfJumpInputEl?.select();
  }

  function closePdfPageJump(): void {
    detailPdfJumpOpen = false;
    detailPdfJumpValue = "";
  }

  function submitPdfPageJump(): void {
    if (!detailOpen || detailMode !== "pdf") {
      closePdfPageJump();
      return;
    }

    const parsed = parsePageNumber(detailPdfJumpValue);
    if (!parsed) {
      closePdfPageJump();
      return;
    }

    const bounded = detailPdfPageCount > 0 ? Math.min(detailPdfPageCount, parsed) : parsed;
    detailPage = `${Math.max(1, bounded)}`;
    detailPdfCurrentPage = Math.max(1, bounded);
    writeRouteState("replace");
    closePdfPageJump();
  }

  async function openDetailById(entityId: string, updateUrl = true): Promise<void> {
    const existing = results.find((item) => item.entityId === entityId);
    if (existing) {
      await openDetail(existing, updateUrl);
      return;
    }

    const content = await loadDetailContent(entityId);
    if (!content) {
      return;
    }

    await openDetail({
      entityId: content.entityId,
      entityType: content.entityType,
      entityTypeLabel: content.entityTypeLabel ?? (content.entityType === "Meeting" ? "Vergadering" : "Document"),
      organization: content.organization ?? "Onbekende organisatie",
      date: content.date ?? "Datum onbekend",
      title: content.title ?? "Ongetiteld",
      summary: "",
      sortDate: content.sortDate,
      downloadUrl: content.downloadUrl,
    }, updateUrl);
  }

  function handleAgendaDocumentOpen(event: CustomEvent<{ entityId: string }>): void {
    void openDetailById(event.detail.entityId);
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

  async function fetchSearchPage(offset: number, signal?: AbortSignal): Promise<SearchResponse> {
    const params = routeStateToSearchParams({ ...currentRouteState(), view: "" });
    params.set("offset", `${offset}`);
    params.set("limit", `${PAGE_SIZE}`);
    return await fetchJson<SearchResponse>(`/api/search?${params.toString()}`, { signal });
  }

  async function runSearch(mode: "push" | "replace" = "push"): Promise<void> {
    const hasFilters = hasActiveSearchFilters();

    if (!hasFilters) {
      searchAbortController?.abort();
      searchAbortController = null;
      searched = false;
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
    searchAbortController?.abort();
    searchAbortController = new AbortController();
    const { signal } = searchAbortController;

    try {
      const payload = await fetchSearchPage(0, signal);
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
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      if (requestId === searchRequestId) {
        results = [];
        totalCount = null;
        totalIsApproximate = false;
        hasMore = false;
      }
    } finally {
      if (requestId === searchRequestId) {
        if (searchAbortController?.signal === signal) {
          searchAbortController = null;
        }
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
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      throw error;
    } finally {
      if (requestId === searchRequestId) {
        loadingMore = false;
      }
    }
  }

  function scheduleSearch(delayMs = 300): void {
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

    if (query.trim().length < 2 && !hasAdvancedSearchFilters()) {
      searchAbortController?.abort();
      searchAbortController = null;
      results = [];
      totalCount = null;
      totalIsApproximate = false;
      hasMore = false;
      loading = false;
      loadingMore = false;
      activeSearchSignature = "";
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
    detailPdfCurrentPage = parsePageNumber(state.page) ?? 1;
    filtersOpen = hasAdvancedSearchFilters();
  }

  function handlePdfPageChange(event: CustomEvent<{ page: number; pageCount: number }>): void {
    if (!detailOpen || !detailItem || detailMode !== "pdf") {
      return;
    }

    detailPdfPageCount = event.detail.pageCount;
    detailPdfCurrentPage = event.detail.page;
    if (!detailPdfJumpOpen) {
      detailPdfJumpValue = `${event.detail.page}`;
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
      return;
    }

    if (isEditableKeyboardTarget(event.target)) {
      return;
    }

    if (scrollActiveDetailContent(event)) {
      event.preventDefault();
    }
  }

  onMount(async () => {
    preferredDetailMode = loadPreferredDetailMode();
    updateInitialLoadingCardCount();
    fetch("/api/stats")
      .then((r) => r.json())
      .then(
        (stats: {
          documentCount?: number;
          organizationCount?: number;
          municipalityCount?: number;
          waterBoardCount?: number;
          provinceCount?: number;
        }) => {
          indexDocumentCount = stats.documentCount ?? null;
          indexOrganizationCount = stats.organizationCount ?? null;
          indexMunicipalityCount = stats.municipalityCount ?? indexMunicipalityCount;
          indexWaterBoardCount = stats.waterBoardCount ?? indexWaterBoardCount;
          indexProvinceCount = stats.provinceCount ?? indexProvinceCount;
        },
      )
      .catch(() => {});
    await loadSources();
    await syncFromUrl(true);
    document.addEventListener("keydown", handleEscape);
    window.addEventListener("resize", updateInitialLoadingCardCount);
    loadMoreObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void loadMoreResults();
      }
    }, { rootMargin: "960px 0px" });
    if (!hasActiveSearchFilters() && !view) {
      focusQuery();
    }
  });

  onDestroy(() => {
    if (debounceTimer) {
      window.clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    searchAbortController?.abort();
    document.removeEventListener("keydown", handleEscape);
    window.removeEventListener("resize", updateInitialLoadingCardCount);
    loadMoreObserver?.disconnect();
    loadMoreObserver = null;
    document.body.classList.remove("body--locked");
  });

  $: {
    loadMoreObserver?.disconnect();
    if (loadMoreObserver && loadMoreSentinelEl && searched && hasMore) {
      loadMoreObserver.observe(loadMoreSentinelEl);
    }
  }

  $: {
    const shouldLockBody = detailOpen || showApiDocs;
    document.body.classList.toggle("body--locked", shouldLockBody);
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
  $: loadMoreSkeletonCount = totalCount !== null
    ? Math.max(1, Math.min(PAGE_SIZE, totalCount - results.length))
    : PAGE_SIZE;
  $: if (detailOpen && detailMode === "text" && detailContent && detailMarkdownHtml) {
    void syncDetailText();
  }

  $: if (detailOpen) {
    detailMode;
    detailLoading;
    detailItem?.entityType;
    detailTextEl;
    detailPdfEl;
    void focusActiveDetailSurface();
  }
</script>

<svelte:window on:popstate={handlePopstate} />

<div class:page-shell--search={searched} class="page-shell">
  <header class:hero--search={searched} class="hero">
    <div class="hero__glow hero__glow--left"></div>
    <div class="hero__glow hero__glow--right"></div>
    <div class="hero__frame">
      <div class="hero__masthead">
        <!-- Admin link removed — double-click "vergaderstukken" to access admin -->
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

          <ul class="hero__meta">
            <li on:dblclick={() => { window.location.href = "/admin.html"; }}><strong>{(indexDocumentCount ?? fallbackDocumentCount).toLocaleString("nl-NL")}</strong> vergaderstukken</li>
            <li>
              <button
                type="button"
                class="hero__meta-trigger"
                aria-expanded={homeOrgPickerOpen}
                aria-haspopup="listbox"
                aria-controls={homeOrgPickerOpen ? "home-org-picker" : undefined}
                on:click={async () => {
                  const opening = !homeOrgPickerOpen;
                  homeOrgPickerOpen = opening;
                  if (opening) {
                    await tick();
                    homeOrgPickerRef?.focusInput();
                  }
                }}
              >
                <span class="hero__meta-trigger__label">
                  <strong>{indexOrganizationCount ?? fallbackOrganizationCount}</strong>
                  organisaties
                </span>
                <span class="hero__meta-trigger__chevron" aria-hidden="true"></span>
              </button>
            </li>
          </ul>
          {#if homeOrgPickerOpen && !searched}
            <div id="home-org-picker" class="hero__org-picker" transition:fade={{ duration: 140 }}>
              <SourcePicker
                bind:this={homeOrgPickerRef}
                options={sources}
                bind:value={homeOrgPickerValue}
                placeholder="Zoek een organisatie..."
                subtitle={publicSourcePickerSubtitle}
                valueSelector={(source) => source.key}
                on:change={(event) => {
                  const next = event.detail.value;
                  if (!next) return;
                  organization = next;
                  homeOrgPickerOpen = false;
                  homeOrgPickerValue = "";
                  // From the home page `searched` is still false, so
                  // onFilterChange() would short-circuit. onQuerySearch
                  // runs the home→results transition then searches.
                  void onQuerySearch();
                }}
              />
            </div>
          {/if}
        </div>
      </div>

      <form
        class="search-panel"
        on:submit|preventDefault={() => {
          // Route form submit through onQuerySearch so the home→results
          // transition (animateModeChange + searched=true) runs before the
          // fetch. Calling runSearch() directly here left searched=false,
          // so {#if searched} gated the results panel away until the input's
          // separate on:search event happened to fire a second runSearch.
          void onQuerySearch();
        }}
      >
        <div class="search-panel__query-row">
          <label bind:this={primarySearchFieldEl} class="search-field search-field--primary">
            <input
              bind:this={queryInputEl}
              bind:value={query}
              name="query"
              type="search"
              placeholder="Zoeken in documenten, vergaderingen, agenda's, besluiten..."
              autocomplete="off"
              on:input={onQueryInput}
              on:search={() => {
                void onQuerySearch();
              }}
            />
          </label>
        </div>
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
          <button
            type="button"
            class="ghost-button ghost-button--subtle search-results__toggle"
            aria-expanded={filtersOpen}
            on:click={() => {
              filtersOpen = !filtersOpen;
            }}
          >
            <span class="search-panel__toggle-icon" aria-hidden="true">⚙</span>
            <span class="search-panel__toggle-label">Filters</span>
          </button>
        </div>

        {#if filtersOpen}
          <div class="search-results__filters">
            <div class="search-panel__options">
              <SourcePicker
                options={sources}
                bind:value={organization}
                placeholder="Zoek organisatie"
                subtitle={publicSourcePickerSubtitle}
                valueSelector={(source) => source.key}
                on:change={onSourceChange}
              />

              <label class="select-field select-field--subtle select-field--compact">
                <span class="sr-only">Type resultaat</span>
                <select bind:value={entityType} name="entityType" on:change={onFilterChange}>
                  <option value="">Type</option>
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
          </div>
        {/if}

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
            {#each results as item, index (item.entityId)}
              <button
                type="button"
                class="surface-card surface-card--lift result-card"
                class:result-card--with-preview={Boolean(item.previewImageUrl)}
                data-result-id={item.entityId}
                on:click={() => void openDetail(item)}
                on:keydown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    void openDetail(item);
                  }
                }}
              >
                <div class:result-card__layout--with-preview={Boolean(item.previewImageUrl)} class="result-card__layout">
                  {#if item.previewImageUrl}
                    <div
                      class="result-card__preview"
                      class:result-card__preview--loaded={loadedPreviewImages.has(previewLoadKey(item))}
                      aria-hidden="true"
                    >
                      <img
                        alt=""
                        class="result-card__preview-image"
                        decoding="async"
                        fetchpriority={previewImageFetchPriority(index)}
                        loading={previewImageLoading(index)}
                        on:load={() => markPreviewLoaded(item)}
                        src={item.previewImageUrl}
                      />
                    </div>
                  {/if}

                  <div class="result-card__content">
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
                  </div>
                </div>
              </button>
            {/each}

            {#if loadingMore}
              {#each Array.from({ length: loadMoreSkeletonCount }) as _, index}
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
            {/if}

            {#if hasMore}
              <div bind:this={loadMoreSentinelEl} class="result-list__sentinel" aria-hidden="true">
              </div>
            {:else if searched && results.length > 0 && !loading && !loadingMore}
              <div class="result-list__end">Geen verdere resultaten.</div>
            {/if}
          {/if}
        </div>
      </section>
    </main>
  {:else}
    <main class="content content--home" transition:fade={{ duration: 220 }}>
      <div class="home-about">
        <h1 class="home-about__title">
          Doorzoek vergaderstukken
          van gemeenten, provincies en waterschappen
        </h1>

        <div class="home-about__prose prose-detail">
          <p>
            OpenBesluitvorming is een initiatief om de besluitvorming van decentrale overheden transparanter te maken
            en een bijdrage te leveren aan de lokale democratie. Dit doen we door de vergaderdata samen te brengen in
            één zoekomgeving. Dit wordt gedaan door automatisch uit de bestaande vergadersoftware
            (raadsinformatiesystemen) de vergaderingen en documenten te halen en deze vervolgens middels een
            <button type="button" class="inline-link" on:click={() => void openApiDocs()}>API</button>
            en deze zoekmachine te ontsluiten.
          </p>
          <p>
            Met deze toepassing zoek je door de openbare vergaderingen, agendapunten, moties en documenten van meer
            dan {indexMunicipalityCount} deelnemende gemeenten, {indexProvinceCount} provincies en {indexWaterBoardCount} waterschappen. Naast documenten zijn ook rijkere data
            beschikbaar over onder andere stemgedrag.
          </p>

          <h2>Door wie</h2>
          <p>
            Vanuit het
            <a href="https://www.open-overheid.nl/over-open-overheid/actieplan-open-overheid" rel="noopener noreferrer"
              target="_blank">actieplan open overheid</a>
            werkt
            <a href="https://www.vngrealisatie.nl/" rel="noopener noreferrer" target="_blank">VNG Realisatie</a>
            aan het openstellen van besluitvorming van gemeenten en provincies als open data. Inmiddels is de Wet Open
            Overheid van kracht en heeft VNG het informatiemodel mede in dat licht verder aangescherpt en verrijkt in
            samenwerking met IPO en UvW en daarmee ook toepasbaar gemaakt voor provincies en waterschappen.
          </p>
          <p>
            De techniek is gemaakt door
            <a href="https://ontola.io/nl" rel="noopener noreferrer" target="_blank">Ontola</a>.
            <a
              href="https://github.com/ontola/openbesluitvorming"
              rel="noopener noreferrer"
              target="_blank">GitHub</a>,
            samen met de
            <button type="button" class="inline-link" on:click={() => void openApiDocs()}>API-documentatie</button>
            voor hergebruikers.
          </p>
          <p>OpenBesluitvorming komt voort uit het project OpenRaadsinformatie en OpenStateninformatie, welke waren gestart door de Open State Foundation.</p>

          <h2>Toekomst</h2>
          <p>
            Momenteel wordt in samenwerking met IPO, UvW, BZK, KOOP en leveranciers gewerkt aan de ORI API die zorgt
            voor verbinding met de Woo-index en zoekfunctie. Door het gebruik van deze ORI API zullen de
            bestuursorganen in staat zijn deze rijke informatiestroom geautomatiseerd actief openbaar te maken in het
            kader van de Wet Open Overheid. Heel concreet betreft het de informatiecategorieën 3.3 2a (ingekomen
            stukken) en 3.3 2c (vergaderstukken en verslagen) die hiermee vindbaar worden in de Woo-index en
            zoekfunctie.
          </p>
          <p>
            Daarbovenop kan elke partij, net als de Woo-index, zich door deze API gedragen als hergebruiker en gebruik
            maken van deze rijke collectie.
          </p>
          <p>
            Het uiteindelijke doel is dat de Woo-index en zoekfunctie conform de Common Ground principes de data bij de
            bron zal ophalen. Dit stelt de Woo-index en zoekfunctie in staat de raadpleegfunctie over te nemen van deze
            huidige raadpleegomgeving die als overbrugging geldt tot dat moment.
          </p>
          <p>
            Documentatie over deze ontwikkeling is op
            <a href="https://vng-realisatie.github.io/ODS-Open-Raadsinformatie/" rel="noopener noreferrer" target="_blank">GitHub</a>
            na te lezen. Specifiek voor de Woo-index en zoekfunctie is dit op de
            <a href="https://gitlab.com/koop/woo" rel="noopener noreferrer" target="_blank">GitLab</a>
            terug te lezen.
          </p>

          <h2>Voor wie is deze app?</h2>
          <ul>
            <li><strong>Ambtenaren</strong> zoeken naar hoe andere overheden bepaalde problemen oplossen.</li>
            <li><strong>Ontwikkelaars</strong> gaan aan de slag met deze data om eigen apps te maken.</li>
            <li><strong>Betrokken burgers</strong> zoeken wat overheden hebben gezegd over een bepaald onderwerp.</li>
            <li><strong>Belangenbehartigers</strong> kunnen volgen waar beslissingen over (gaan) worden gemaakt.</li>
            <li><strong>Journalisten</strong> zien hoe besluitvorming zich heeft ontwikkeld over tijd.</li>
          </ul>

          <h2>Jouw gemeente, provincie of waterschap toevoegen</h2>
          <p>
            Als je wil dat ook jouw organisatie aangesloten wordt op OpenBesluitvorming, vraag dan de griffie van je
            gemeenteraad om
            <a href="https://formulieren.vngrealisatie.nl/deelname_openraadsinformatie" rel="noopener noreferrer"
              target="_blank">dit formulier</a>
            in te vullen.
          </p>

          <h2>Andere apps gemaakt met deze data</h2>
          <p>
            Alle data (moties, vergaderingen, documenten, agendapunten, stukken…) is gratis te gebruiken. Deze
            zoekmachine is dan ook maar één van de apps die is gemaakt met de data:
          </p>
          <ul>
            <li>
              <a href="https://1848.nl" rel="noopener noreferrer" target="_blank">1848.nl</a>: volg thema&apos;s die
              worden besproken en ontvang meldingen.
            </li>
            <li>
              Jouw app hier? Mail
              <a href="mailto:sander.bakker@vng.nl">Sander Bakker</a>.
            </li>
          </ul>

          <h2>Contact</h2>
          <p>
            Technische vragen, klachten of suggesties over deze zoekmachine en de zoek API kunnen op de
            <a href="https://github.com/ontola/openbesluitvorming/issues" rel="noopener noreferrer" target="_blank"
              >issue tracker van het project</a>
            geplaatst worden.
          </p>
          <p>
            Voor informatie over de nieuwe ORI-API standaard voor leveranciers kun je kijken op
            <a href="https://github.com/VNG-Realisatie/ODS-Open-Raadsinformatie" rel="noopener noreferrer" target="_blank"
              >deze repository</a>.
          </p>
          <p>
            Voor algemene vragen kunt u mailen naar
            <a href="mailto:sander.bakker@vng.nl">Sander Bakker</a>.
          </p>

          <h2>Privacy</h2>
          <p>
            We gebruiken Swetrix (een privacy-vriendelijk alternatief voor Google Analytics) om bezoekersstatistieken te
            verzamelen. We gebruiken deze gegevens alleen om anonieme rapportages te maken van bezoekers, en verkopen
            deze data aan niemand door. We slaan de laatste zes cijfers van IP-adressen niet op om jouw privacy te
            beschermen.
          </p>

          <h2>Disclaimer</h2>
          <p>
            De data in deze zoekmachine komt uit vergadersystemen gekoppeld aan OpenBesluitvorming. Deze data is met
            toestemming van de deelnemende gemeenten, provincies en waterschappen geïmporteerd uit diverse
            vergadersystemen. De data kan door het importeren incompleet, onjuist of niet up-to-date zijn. Het
            eigenaarschap van de data ligt bij de organisaties die de data hebben aangemaakt, of de respectievelijke
            auteurs van de documenten.
          </p>
        </div>
      </div>
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
      bind:this={detailDialogEl}
      class="detail-sheet detail-sheet--reader"
      aria-modal="true"
      aria-labelledby="detail-title"
      tabindex="-1"
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
          {#if detailContent?.meetingId}
            <button
              type="button"
              class="detail-sheet__meeting-crumb"
              on:click={() => void openDetailById(detailContent.meetingId)}
            >
              ← Bekijk vergadering
            </button>
          {/if}
          <h2 id="detail-title">{detailItem.title}</h2>
        </div>
      </div>

      <div class="detail-sheet__body">
        {#if detailMode === "text"}
          {#if detailItem.entityType === "Meeting"}
            <div class="detail-sheet__meeting">
              <div class="detail-sheet__meeting-intro">
                <p class="detail-sheet__meeting-label">Agenda</p>
                {#if detailContent?.agenda?.length}
                  <p class="detail-sheet__meeting-copy">
                    Bekijk agendapunten en gekoppelde documenten van deze vergadering.
                  </p>
                {/if}
              </div>
              {#if detailContent?.agenda?.length}
                <MeetingAgendaTree items={detailContent.agenda} on:opendocument={handleAgendaDocumentOpen} />
              {:else}
                <p class="detail-sheet__meeting-empty">Geen agenda beschikbaar.</p>
              {/if}
            </div>
          {:else}
            <div bind:this={detailTextEl} class="detail-sheet__text prose-detail" tabindex="-1">
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
          {/if}
        {:else}
          <div bind:this={detailPdfEl} class="detail-sheet__pdf" tabindex="-1">
            <div class="detail-sheet__pdf-overlay">
              {#if detailPdfJumpOpen}
                <form class="detail-sheet__pdf-page-form" on:submit|preventDefault={submitPdfPageJump}>
                  <input
                    bind:this={detailPdfJumpInputEl}
                    bind:value={detailPdfJumpValue}
                    class="detail-sheet__pdf-page-input"
                    inputmode="numeric"
                    min="1"
                    max={detailPdfPageCount > 0 ? `${detailPdfPageCount}` : undefined}
                    on:blur={closePdfPageJump}
                    on:keydown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        closePdfPageJump();
                      }
                    }}
                    pattern="[0-9]*"
                    type="number"
                  />
                  {#if detailPdfPageCount > 0}
                    <span class="detail-sheet__pdf-counter">/ {detailPdfPageCount}</span>
                  {/if}
                </form>
              {:else}
                <button
                  type="button"
                  class="detail-sheet__pdf-page-button"
                  aria-label="Ga naar pagina"
                  on:click={() => void openPdfPageJump()}
                >
                  <span class="detail-sheet__pdf-counter">
                    {detailPdfCurrentPage}{#if detailPdfPageCount > 0} / {detailPdfPageCount}{/if}
                  </span>
                </button>
              {/if}
              <button
                type="button"
                class="detail-sheet__pdf-jump"
                aria-label="Ga naar eerste pagina"
                disabled={detailPdfCurrentPage <= 1}
                on:click={jumpToFirstPdfPage}
              >
                ↑
              </button>
            </div>
            {#key detailItem.entityId}
              <PdfDocumentView
                initialPage={parsePageNumber(detailPage) ?? detailItem.matchedPage ?? null}
                on:pagechange={handlePdfPageChange}
                url={entityPdfProxyUrl(detailItem.entityId)}
              />
            {/key}
          </div>
        {/if}
      </div>
    </div>
  </section>
{/if}

{#if showApiDocs}
  <section class="detail-overlay" transition:fade={{ duration: 160 }}>
    <button
      type="button"
      class="detail-overlay__backdrop"
      aria-label="Sluiten"
      on:click={() => (showApiDocs = false)}
    ></button>
    <div
      class="detail-sheet detail-sheet--reader"
      aria-modal="true"
      role="dialog"
      in:scale={{ duration: 200, start: 0.97 }}
      out:scale={{ duration: 160, start: 0.985 }}
    >
      <div class="detail-sheet__header">
        <div class="detail-sheet__header-bar">
          <div class="detail-sheet__meta">
            <span class="pill">API</span>
          </div>
          <div class="detail-sheet__header-actions">
            <button
              type="button"
              class="ghost-button"
              aria-label="Sluiten"
              on:click={() => (showApiDocs = false)}
            >✕</button>
          </div>
        </div>
        <div class="detail-sheet__header-top">
          <h2 class="detail-sheet__title">Search API</h2>
        </div>
      </div>
      <div class="detail-sheet__body">
        <div class="detail-sheet__text prose-detail">
          <!-- eslint-disable-next-line svelte/no-at-html-tags -->
          {@html apiDocsHtml}
        </div>
      </div>
    </div>
  </section>
{/if}
