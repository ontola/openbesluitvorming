/// <reference lib="dom" />

import { marked } from "marked";
import type {
  AdminSourceOption,
  AdminSourcesResponse,
  EntityContentResponse,
  SearchResponse,
  SearchResult,
} from "../../src/types.ts";
import { createSourcePicker } from "./source_picker.ts";

type SearchRouteState = {
  query: string;
  organization: string;
  entityType: string;
  sort: string;
  dateFrom: string;
  dateTo: string;
  view: string;
};

type WindowLike = {
  location: {
    href: string;
    search: string;
  };
  history: {
    pushState(data: unknown, unused: string, url?: string | URL | null): void;
    replaceState(data: unknown, unused: string, url?: string | URL | null): void;
  };
  addEventListener(type: "popstate", listener: () => void): void;
  setTimeout(handler: TimerHandler, timeout?: number): unknown;
  clearTimeout(id: unknown): void;
};

function renderState(
  document: Document,
  resultList: HTMLElement,
  resultsStatus: HTMLElement,
  message: string,
): void {
  resultList.textContent = "";
  resultList.classList.remove("result-list--loading");
  resultList.removeAttribute("aria-busy");
  resultsStatus.hidden = true;

  const state = document.createElement("div");
  state.className = "result-state";
  state.textContent = message;
  resultList.appendChild(state);
}

function setResultsLoading(
  resultList: HTMLElement,
  resultsStatus: HTMLElement,
  isLoading: boolean,
): void {
  resultList.classList.toggle("result-list--loading", isLoading);
  resultsStatus.hidden = !isLoading;
  if (isLoading) {
    resultList.setAttribute("aria-busy", "true");
    return;
  }
  resultList.removeAttribute("aria-busy");
}

function renderResults(
  resultList: HTMLElement,
  resultsStatus: HTMLElement,
  template: HTMLTemplateElement,
  items: SearchResult[],
  onSelect: (item: SearchResult) => void,
): void {
  resultList.textContent = "";
  setResultsLoading(resultList, resultsStatus, false);

  if (items.length === 0) {
    renderState(
      resultList.ownerDocument,
      resultList,
      resultsStatus,
      "Geen resultaten gevonden voor deze zoekopdracht.",
    );
    return;
  }

  items.forEach((item, index) => {
    const fragment = template.content.cloneNode(true) as DocumentFragment;
    const article = fragment.querySelector<HTMLElement>(".result-card");
    if (!article) {
      throw new Error("Result template mist .result-card");
    }

    const org = fragment.querySelector<HTMLElement>('[data-role="org"]');
    const type = fragment.querySelector<HTMLElement>('[data-role="type"]');
    const date = fragment.querySelector<HTMLElement>('[data-role="date"]');
    const title = fragment.querySelector<HTMLElement>('[data-role="title"]');
    const summary = fragment.querySelector<HTMLElement>('[data-role="summary"]');

    if (!org || !type || !date || !title || !summary) {
      throw new Error("Result template mist vereiste data-role velden");
    }

    org.textContent = item.organization;
    type.textContent = item.entityTypeLabel;
    date.textContent = item.date;
    title.textContent = item.title;
    if (item.summaryHtml) {
      summary.innerHTML = item.summaryHtml;
    } else {
      summary.textContent = item.summary;
    }

    article.tabIndex = 0;
    article.setAttribute("role", "button");
    article.style.animationDelay = `${index * 70}ms`;
    article.addEventListener("click", () => onSelect(item));
    article.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onSelect(item);
      }
    });
    resultList.appendChild(fragment);
  });
}

function requiredElement<TElement extends Element>(document: Document, selector: string): TElement {
  const element = document.querySelector<TElement>(selector);
  if (!element) {
    throw new Error(`Element niet gevonden: ${selector}`);
  }
  return element;
}

function escapeRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getHighlightTerms(query: string): string[] {
  const normalized = query.trim();
  if (!normalized) {
    return [];
  }

  const terms = normalized
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);

  return [...new Set(terms)].sort((left, right) => right.length - left.length);
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

function pdfViewerUrl(url: string): string {
  const hash = "toolbar=0&navpanes=0&view=FitH";
  return url.includes("#") ? `${url}&${hash}` : `${url}#${hash}`;
}

function loadingMarkdownSkeleton(): string {
  return `
    <div class="detail-sheet__loading" aria-hidden="true">
      <span class="detail-sheet__loading-line detail-sheet__loading-line--title"></span>
      <span class="detail-sheet__loading-line"></span>
      <span class="detail-sheet__loading-line"></span>
      <span class="detail-sheet__loading-line detail-sheet__loading-line--short"></span>
      <span class="detail-sheet__loading-line"></span>
      <span class="detail-sheet__loading-line"></span>
      <span class="detail-sheet__loading-line detail-sheet__loading-line--medium"></span>
    </div>
  `;
}

function highlightElementText(root: HTMLElement, query: string): void {
  const terms = getHighlightTerms(query);
  if (terms.length === 0) {
    return;
  }

  const pattern = new RegExp(`(${terms.map(escapeRegex).join("|")})`, "gi");
  const showText = root.ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = root.ownerDocument.createTreeWalker(root, showText);
  const nodes: Text[] = [];

  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const parent = node.parentElement;
    if (!parent || parent.closest("mark, script, style")) {
      continue;
    }
    if (!node.nodeValue?.trim()) {
      continue;
    }
    nodes.push(node);
  }

  for (const node of nodes) {
    const value = node.nodeValue ?? "";
    pattern.lastIndex = 0;
    if (!pattern.test(value)) {
      continue;
    }

    pattern.lastIndex = 0;
    const fragment = root.ownerDocument.createDocumentFragment();
    let lastIndex = 0;

    for (const match of value.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (index > lastIndex) {
        fragment.append(value.slice(lastIndex, index));
      }

      const mark = root.ownerDocument.createElement("mark");
      mark.textContent = match[0];
      fragment.appendChild(mark);
      lastIndex = index + match[0].length;
    }

    if (lastIndex < value.length) {
      fragment.append(value.slice(lastIndex));
    }

    node.parentNode?.replaceChild(fragment, node);
  }
}

function routeStateFromUrl(url: URL): SearchRouteState {
  return {
    query: url.searchParams.get("query") ?? "",
    organization: url.searchParams.get("organization") ?? "",
    entityType: url.searchParams.get("entityType") ?? "",
    sort: url.searchParams.get("sort") ?? "date_desc",
    dateFrom: url.searchParams.get("dateFrom") ?? "",
    dateTo: url.searchParams.get("dateTo") ?? "",
    view: url.searchParams.get("view") ?? "",
  };
}

function applyRouteStateToForm(
  state: SearchRouteState,
  controls: {
    queryInput: HTMLInputElement;
    organizationInput: HTMLInputElement;
    entityTypeSelect: HTMLSelectElement;
    dateFromInput: HTMLInputElement;
    dateToInput: HTMLInputElement;
    sortSelect: HTMLSelectElement;
  },
): void {
  controls.queryInput.value = state.query;
  controls.organizationInput.value = state.organization;
  controls.entityTypeSelect.value = state.entityType;
  controls.dateFromInput.value = state.dateFrom;
  controls.dateToInput.value = state.dateTo;
  controls.sortSelect.value = state.sort;
}

async function fetchJson<TPayload>(fetchImpl: typeof fetch, url: string): Promise<TPayload> {
  const response = await fetchImpl(url);
  const payload = (await response.json()) as TPayload & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error ?? "Verzoek mislukt");
  }
  return payload;
}

function routeStateToSearchParams(state: SearchRouteState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.query) {
    params.set("query", state.query);
  }
  if (state.organization) {
    params.set("organization", state.organization);
  }
  if (state.entityType) {
    params.set("entityType", state.entityType);
  }
  if (state.sort) {
    params.set("sort", state.sort);
  }
  if (state.dateFrom) {
    params.set("dateFrom", state.dateFrom);
  }
  if (state.dateTo) {
    params.set("dateTo", state.dateTo);
  }
  if (state.view) {
    params.set("view", state.view);
  }
  return params;
}

function sameSearchState(left: SearchRouteState, right: SearchRouteState): boolean {
  return (
    left.query === right.query &&
    left.organization === right.organization &&
    left.entityType === right.entityType &&
    left.dateFrom === right.dateFrom &&
    left.dateTo === right.dateTo &&
    left.sort === right.sort
  );
}

function hasActiveSearchFilters(state: SearchRouteState): boolean {
  return (
    state.query.trim().length > 0 ||
    state.organization.trim().length > 0 ||
    state.entityType.trim().length > 0 ||
    state.dateFrom.trim().length > 0 ||
    state.dateTo.trim().length > 0
  );
}

function hasAdvancedSearchFilters(state: SearchRouteState): boolean {
  return (
    state.organization.trim().length > 0 ||
    state.entityType.trim().length > 0 ||
    state.dateFrom.trim().length > 0 ||
    state.dateTo.trim().length > 0
  );
}

export async function bootstrapSearchApp({
  document,
  fetchImpl = fetch,
  windowImpl = window,
}: {
  document: Document;
  fetchImpl?: typeof fetch;
  windowImpl?: WindowLike;
}): Promise<void> {
  const form = requiredElement<HTMLFormElement>(document, "#search-form");
  const brandHome = requiredElement<HTMLAnchorElement>(document, "#brand-home");
  const queryInput = requiredElement<HTMLInputElement>(document, "#query");
  const filtersToggle = requiredElement<HTMLButtonElement>(document, "#filters-toggle");
  const advancedFilters = requiredElement<HTMLElement>(document, "#search-advanced-filters");
  const organizationQueryInput = requiredElement<HTMLInputElement>(document, "#organization-query");
  const organizationInput = requiredElement<HTMLInputElement>(document, "#organization");
  const organizationResults = requiredElement<HTMLElement>(document, "#organization-results");
  const entityTypeSelect = requiredElement<HTMLSelectElement>(document, "#entity-type");
  const dateFromInput = requiredElement<HTMLInputElement>(document, "#date-from");
  const dateToInput = requiredElement<HTMLInputElement>(document, "#date-to");
  const sortSelect = requiredElement<HTMLSelectElement>(document, "#sort");
  const resultsSection = requiredElement<HTMLElement>(document, "#search-results");
  const resultsTitleText = requiredElement<HTMLElement>(document, "#results-title-text");
  const resultsStatus = requiredElement<HTMLElement>(document, "#results-status");
  const content = requiredElement<HTMLElement>(document, "#content");
  const resultList = requiredElement<HTMLElement>(document, "#result-list");
  const template = requiredElement<HTMLTemplateElement>(document, "#result-template");
  const detailOverlay = requiredElement<HTMLElement>(document, "#detail-overlay");
  const detailTitle = requiredElement<HTMLElement>(document, '[data-role="detail-title"]');
  const detailOrg = requiredElement<HTMLElement>(document, '[data-role="detail-org"]');
  const detailType = requiredElement<HTMLElement>(document, '[data-role="detail-type"]');
  const detailDate = requiredElement<HTMLElement>(document, '[data-role="detail-date"]');
  const detailText = requiredElement<HTMLElement>(document, '[data-role="detail-text"]');
  const detailPdf = requiredElement<HTMLElement>(document, '[data-role="detail-pdf"]');
  const detailPdfFrame = requiredElement<HTMLIFrameElement>(
    document,
    '[data-role="detail-pdf-frame"]',
  );
  const detailPdfFallback = requiredElement<HTMLElement>(
    document,
    '[data-role="detail-pdf-fallback"]',
  );
  const detailPdfOpen = requiredElement<HTMLAnchorElement>(
    document,
    '[data-role="detail-pdf-open"]',
  );
  const detailViewSwitch = requiredElement<HTMLElement>(
    document,
    '[data-role="detail-view-switch"]',
  );
  const detailViewText = requiredElement<HTMLButtonElement>(
    document,
    '[data-role="detail-view-text"]',
  );
  const detailViewPdf = requiredElement<HTMLButtonElement>(
    document,
    '[data-role="detail-view-pdf"]',
  );
  const detailDownload = requiredElement<HTMLAnchorElement>(
    document,
    '[data-role="detail-download"]',
  );
  const closeDetailButtons = document.querySelectorAll<HTMLElement>('[data-role="close-detail"]');

  let currentResults: SearchResult[] = [];
  let currentSearchState: SearchRouteState = routeStateFromUrl(new URL(windowImpl.location.href));
  const detailCache = new Map<string, EntityContentResponse | null>();
  let organizationPicker: ReturnType<typeof createSourcePicker> | null = null;
  let filtersOpen = hasAdvancedSearchFilters(currentSearchState);
  let currentDetailMode: "text" | "pdf" = "text";
  let currentDetailPdfUrl: string | null = null;
  let pendingSearchTimer: unknown = null;

  function focusQueryInput(): void {
    windowImpl.setTimeout(() => {
      queryInput.focus();
      queryInput.select();
    }, 0);
  }

  function syncFilterVisibility(): void {
    advancedFilters.hidden = !filtersOpen;
    filtersToggle.setAttribute("aria-expanded", String(filtersOpen));
    filtersToggle.textContent = filtersOpen ? "Filters verbergen" : "Filters tonen";
  }

  function setResultsTitle(title: string, count?: number): void {
    if (typeof count === "number" && count >= 0) {
      resultsTitleText.textContent = `${title} (${count})`;
      return;
    }

    resultsTitleText.textContent = title;
  }

  function setSearchedState(searched: boolean, title: string): void {
    resultsSection.hidden = !searched;
    setResultsTitle(title);
    content.hidden = searched;
  }

  function isHomeState(state: SearchRouteState): boolean {
    return !hasActiveSearchFilters(state);
  }

  function clearToHome(mode: "push" | "replace" = "push"): void {
    const homeState: SearchRouteState = {
      query: "",
      organization: "",
      entityType: "",
      sort: "date_desc",
      dateFrom: "",
      dateTo: "",
      view: "",
    };
    applyRouteStateToForm(homeState, {
      queryInput,
      organizationInput,
      entityTypeSelect,
      dateFromInput,
      dateToInput,
      sortSelect,
    });
    organizationPicker?.clear();
    filtersOpen = false;
    syncFilterVisibility();
    currentSearchState = homeState;
    currentResults = [];
    setSearchedState(false, "Zoek op organisatie of onderwerp");
    resultList.textContent = "";
    closeDetail({ updateUrl: false, mode: "replace" });
    writeRouteState(homeState, mode);
    focusQueryInput();
  }

  function writeRouteState(state: SearchRouteState, mode: "push" | "replace"): void {
    const nextUrl = new URL(windowImpl.location.href);
    nextUrl.search = routeStateToSearchParams(state).toString();

    if (mode === "push") {
      windowImpl.history.pushState(null, "", nextUrl);
    } else {
      windowImpl.history.replaceState(null, "", nextUrl);
    }
  }

  function currentFormState(): SearchRouteState {
    return {
      query: queryInput.value.trim(),
      organization: organizationInput.value.trim(),
      entityType: entityTypeSelect.value.trim(),
      dateFrom: dateFromInput.value.trim(),
      dateTo: dateToInput.value.trim(),
      sort: sortSelect.value.trim() || "date_desc",
      view: "",
    };
  }

  function cancelPendingSearch(): void {
    if (pendingSearchTimer !== null) {
      windowImpl.clearTimeout(pendingSearchTimer);
      pendingSearchTimer = null;
    }
  }

  async function performSearchFromForm(mode: "push" | "replace" = "push"): Promise<void> {
    cancelPendingSearch();
    try {
      await runSearch(currentFormState(), { mode });
    } catch (error) {
      renderState(
        document,
        resultList,
        resultsStatus,
        error instanceof Error ? error.message : "De zoekmachine reageert niet.",
      );
      setSearchedState(true, "Resultaten");
    }
  }

  function scheduleSearch(delayMs = 300): void {
    cancelPendingSearch();
    pendingSearchTimer = windowImpl.setTimeout(() => {
      pendingSearchTimer = null;
      void performSearchFromForm();
    }, delayMs);
  }

  function closeDetail(options: { updateUrl?: boolean; mode?: "push" | "replace" } = {}): void {
    const { updateUrl = true, mode = "push" } = options;
    detailOverlay.hidden = true;
    document.body.classList.remove("body--locked");
    detailPdfFrame.removeAttribute("src");
    detailPdfFallback.hidden = true;
    detailPdfOpen.removeAttribute("href");
    currentDetailPdfUrl = null;

    if (updateUrl && currentSearchState.view) {
      currentSearchState = { ...currentSearchState, view: "" };
      writeRouteState(currentSearchState, mode);
    }
  }

  function syncDetailModeUi(mode: "text" | "pdf"): void {
    currentDetailMode = mode;
    const showPdf = mode === "pdf";
    detailText.hidden = showPdf;
    detailPdf.hidden = !showPdf;
    detailViewText.setAttribute("aria-pressed", String(!showPdf));
    detailViewPdf.setAttribute("aria-pressed", String(showPdf));
  }

  async function loadDetailContent(entityId: string): Promise<EntityContentResponse | null> {
    if (detailCache.has(entityId)) {
      return detailCache.get(entityId) ?? null;
    }

    const response = await fetchImpl(`/api/entities/${encodeURIComponent(entityId)}`);
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
  }

  async function openDetail(
    item: SearchResult,
    options: { updateUrl?: boolean; mode?: "push" | "replace" } = {},
  ): Promise<void> {
    const { updateUrl = true, mode = "push" } = options;

    detailTitle.textContent = item.title;
    detailOrg.textContent = item.organization;
    detailType.textContent = item.entityTypeLabel;
    detailDate.textContent = item.date;
    detailText.innerHTML = loadingMarkdownSkeleton();
    detailText.hidden = false;
    detailPdf.hidden = true;
    detailPdfFrame.removeAttribute("src");
    detailPdfFallback.hidden = true;
    detailPdfOpen.removeAttribute("href");
    currentDetailPdfUrl = null;
    detailViewSwitch.hidden = true;
    syncDetailModeUi("text");
    detailDownload.hidden = !item.downloadUrl;
    if (item.downloadUrl) {
      detailDownload.href = item.downloadUrl;
    } else {
      detailDownload.removeAttribute("href");
    }

    detailOverlay.hidden = false;
    document.body.classList.add("body--locked");

    if (updateUrl && currentSearchState.view !== item.entityId) {
      currentSearchState = { ...currentSearchState, view: item.entityId };
      writeRouteState(currentSearchState, mode);
    }

    const content = await loadDetailContent(item.entityId);
    if (currentSearchState.view !== item.entityId) {
      return;
    }

    if (content?.downloadUrl) {
      detailDownload.hidden = false;
      detailDownload.href = content.downloadUrl;
    }

    detailText.innerHTML = renderMarkdown(content?.markdownText);
    highlightElementText(detailText, currentSearchState.query);

    const hasPdf = Boolean(content?.pdfUrl);
    currentDetailPdfUrl = content?.pdfUrl ?? null;
    detailViewSwitch.hidden = !hasPdf;
    if (hasPdf && currentDetailPdfUrl) {
      detailPdfOpen.href = currentDetailPdfUrl;
    }

    const preferredMode: "text" | "pdf" = !content?.markdownText?.trim() && hasPdf ? "pdf" : "text";
    syncDetailModeUi(preferredMode);
    if (preferredMode === "pdf" && currentDetailPdfUrl) {
      detailPdfFrame.src = pdfViewerUrl(currentDetailPdfUrl);
    }

    requestAnimationFrame(() => {
      if (currentDetailMode === "pdf") {
        return;
      }
      const firstMatch = detailText.querySelector<HTMLElement>("mark");
      if (firstMatch) {
        firstMatch.scrollIntoView({ block: "center", behavior: "smooth" });
      } else {
        detailText.scrollTop = 0;
      }
    });
  }

  async function runSearch(
    state: SearchRouteState,
    options: { updateUrl?: boolean; mode?: "push" | "replace" } = {},
  ): Promise<void> {
    const { updateUrl = true, mode = "push" } = options;
    const hasFilters = hasActiveSearchFilters(state);
    const title = hasFilters ? "Resultaten" : "Zoek op organisatie of onderwerp";

    currentSearchState = state;
    setSearchedState(hasFilters, title);

    if (!hasFilters) {
      currentResults = [];
      resultList.textContent = "";
      closeDetail({ updateUrl: false, mode: "replace" });
      if (updateUrl) {
        writeRouteState(
          {
            ...state,
            organization: "",
            entityType: "",
            view: "",
          },
          mode,
        );
      }
      return;
    }

    setResultsLoading(resultList, resultsStatus, true);

    if (updateUrl) {
      writeRouteState(currentSearchState, mode);
    }

    const params = routeStateToSearchParams({ ...state, view: "" });
    const response = await fetchImpl(`/api/search?${params.toString()}`);
    const payload = (await response.json()) as Partial<SearchResponse> & { error?: string };

    if (!response.ok) {
      setResultsLoading(resultList, resultsStatus, false);
      throw new Error(payload.error ?? "Zoeken mislukt");
    }

    currentResults = payload.results ?? [];
    setResultsTitle("Resultaten", currentResults.length);
    renderResults(resultList, resultsStatus, template, currentResults, (item) => {
      void openDetail(item);
    });

    if (state.view) {
      const selected = currentResults.find((item) => item.entityId === state.view);
      if (selected) {
        await openDetail(selected, { updateUrl: false });
      } else {
        closeDetail({ updateUrl: false });
      }
    } else {
      closeDetail({ updateUrl: false });
    }
  }

  async function syncFromUrl(options: { replace?: boolean } = {}): Promise<void> {
    const nextState = routeStateFromUrl(new URL(windowImpl.location.href));
    applyRouteStateToForm(nextState, {
      queryInput,
      organizationInput,
      entityTypeSelect,
      dateFromInput,
      dateToInput,
      sortSelect,
    });
    organizationPicker?.setValue(nextState.organization);
    filtersOpen = hasAdvancedSearchFilters(nextState);
    syncFilterVisibility();

    if (sameSearchState(nextState, currentSearchState) && currentResults.length > 0) {
      currentSearchState = nextState;
      if (nextState.view) {
        const selected = currentResults.find((item) => item.entityId === nextState.view);
        if (selected) {
          await openDetail(selected, { updateUrl: false, mode: "replace" });
          return;
        }
      }

      closeDetail({ updateUrl: false, mode: "replace" });
      return;
    }

    if (isHomeState(nextState) && !nextState.view) {
      clearToHome("replace");
      return;
    }

    try {
      await runSearch(nextState, { updateUrl: false, mode: options.replace ? "replace" : "push" });
    } catch (error) {
      renderState(
        document,
        resultList,
        resultsStatus,
        error instanceof Error ? error.message : "De zoekmachine reageert niet.",
      );
      setSearchedState(true, "Resultaten");
    }
  }

  closeDetailButtons.forEach((button: HTMLElement) => {
    button.addEventListener("click", () => closeDetail());
  });

  detailViewText.addEventListener("click", () => {
    syncDetailModeUi("text");
  });

  detailViewPdf.addEventListener("click", () => {
    if (!currentDetailPdfUrl) {
      return;
    }
    if (!detailPdfFrame.getAttribute("src")) {
      detailPdfFrame.src = pdfViewerUrl(currentDetailPdfUrl);
    }
    syncDetailModeUi("pdf");
  });

  detailPdfFrame.addEventListener("error", () => {
    detailPdfFallback.hidden = false;
  });

  document.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape" && !detailOverlay.hidden) {
      closeDetail();
    }
  });

  windowImpl.addEventListener("popstate", () => {
    void syncFromUrl();
  });

  form.addEventListener("submit", async (event: SubmitEvent) => {
    event.preventDefault();
    await performSearchFromForm();
  });

  queryInput.addEventListener("input", () => {
    if (queryInput.value.trim().length === 0) {
      clearToHome("replace");
      cancelPendingSearch();
      return;
    }
    scheduleSearch();
  });

  queryInput.addEventListener("search", () => {
    if (queryInput.value.trim().length === 0) {
      clearToHome("replace");
      cancelPendingSearch();
      return;
    }
    void performSearchFromForm("replace");
  });

  brandHome.addEventListener("click", (event: MouseEvent) => {
    event.preventDefault();
    clearToHome();
  });

  filtersToggle.addEventListener("click", () => {
    filtersOpen = !filtersOpen;
    syncFilterVisibility();
  });

  const sourcePayload = await fetchJson<AdminSourcesResponse>(
    fetchImpl,
    "/api/sources?implemented=true",
  );
  const sourceOptions = (sourcePayload.sources ?? []).filter(
    (source: AdminSourceOption) => source.implemented,
  );
  organizationPicker = createSourcePicker({
    input: organizationQueryInput,
    hiddenInput: organizationInput,
    results: organizationResults,
    options: sourceOptions,
    valueSelector: (source) => source.key,
    subtitle: (source) => `${source.supplier} · ${source.organizationType}`,
  });
  organizationPicker.onSelect(() => {
    void performSearchFromForm();
  });

  entityTypeSelect.addEventListener("change", () => {
    void performSearchFromForm();
  });

  dateFromInput.addEventListener("change", () => {
    void performSearchFromForm();
  });

  dateToInput.addEventListener("change", () => {
    void performSearchFromForm();
  });

  sortSelect.addEventListener("change", () => {
    void performSearchFromForm("replace");
  });

  syncFilterVisibility();
  setSearchedState(false, "Zoek op organisatie of onderwerp");
  resultList.textContent = "";
  await syncFromUrl({ replace: true });
  if (isHomeState(currentSearchState) && !currentSearchState.view) {
    focusQueryInput();
  }
}

if (typeof document !== "undefined") {
  bootstrapSearchApp({ document }).catch((error) => {
    const resultList = document.querySelector<HTMLElement>("#result-list");
    if (resultList) {
      renderState(
        document,
        resultList,
        error instanceof Error ? error.message : "De zoekmachine reageert niet.",
      );
    }
  });
}
