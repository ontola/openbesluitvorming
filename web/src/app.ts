/// <reference lib="dom" />

import { marked } from "marked";
import type { EntityContentResponse, SearchResponse, SearchResult } from "../../src/types.ts";

type SearchRouteState = {
  query: string;
  organization: string;
  entityType: string;
  sort: string;
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
};

function renderState(document: Document, resultList: HTMLElement, message: string): void {
  resultList.textContent = "";

  const state = document.createElement("div");
  state.className = "result-state";
  state.textContent = message;
  resultList.appendChild(state);
}

function renderResults(
  resultList: HTMLElement,
  template: HTMLTemplateElement,
  items: SearchResult[],
  onSelect: (item: SearchResult) => void,
): void {
  resultList.textContent = "";

  if (items.length === 0) {
    renderState(
      resultList.ownerDocument,
      resultList,
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
    view: url.searchParams.get("view") ?? "",
  };
}

function applyRouteStateToForm(
  state: SearchRouteState,
  controls: {
    queryInput: HTMLInputElement;
    organizationSelect: HTMLSelectElement;
    entityTypeSelect: HTMLSelectElement;
    sortSelect: HTMLSelectElement;
  },
): void {
  controls.queryInput.value = state.query;
  controls.organizationSelect.value = state.organization;
  controls.entityTypeSelect.value = state.entityType;
  controls.sortSelect.value = state.sort;
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
    left.sort === right.sort
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
  const queryInput = requiredElement<HTMLInputElement>(document, "#query");
  const organizationSelect = requiredElement<HTMLSelectElement>(document, "#organization");
  const entityTypeSelect = requiredElement<HTMLSelectElement>(document, "#entity-type");
  const sortSelect = requiredElement<HTMLSelectElement>(document, "#sort");
  const fillExampleButton = requiredElement<HTMLButtonElement>(document, "#fill-example");
  const resultsSection = requiredElement<HTMLElement>(document, "#search-results");
  const resultsTitle = requiredElement<HTMLElement>(document, "#results-title");
  const content = requiredElement<HTMLElement>(document, "#content");
  const resultList = requiredElement<HTMLElement>(document, "#result-list");
  const template = requiredElement<HTMLTemplateElement>(document, "#result-template");
  const detailOverlay = requiredElement<HTMLElement>(document, "#detail-overlay");
  const detailTitle = requiredElement<HTMLElement>(document, '[data-role="detail-title"]');
  const detailOrg = requiredElement<HTMLElement>(document, '[data-role="detail-org"]');
  const detailType = requiredElement<HTMLElement>(document, '[data-role="detail-type"]');
  const detailDate = requiredElement<HTMLElement>(document, '[data-role="detail-date"]');
  const detailText = requiredElement<HTMLElement>(document, '[data-role="detail-text"]');
  const detailDownload = requiredElement<HTMLAnchorElement>(
    document,
    '[data-role="detail-download"]',
  );
  const closeDetailButtons = document.querySelectorAll<HTMLElement>('[data-role="close-detail"]');

  let currentResults: SearchResult[] = [];
  let currentSearchState: SearchRouteState = routeStateFromUrl(new URL(windowImpl.location.href));
  const detailCache = new Map<string, EntityContentResponse | null>();

  function setSearchedState(searched: boolean, title: string): void {
    resultsSection.hidden = false;
    resultsTitle.textContent = title;
    content.hidden = searched;
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

  function closeDetail(options: { updateUrl?: boolean; mode?: "push" | "replace" } = {}): void {
    const { updateUrl = true, mode = "push" } = options;
    detailOverlay.hidden = true;
    document.body.classList.remove("body--locked");

    if (updateUrl && currentSearchState.view) {
      currentSearchState = { ...currentSearchState, view: "" };
      writeRouteState(currentSearchState, mode);
    }
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
    detailText.innerHTML = "<p>Document laden...</p>";
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

    requestAnimationFrame(() => {
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
    const hasQuery = state.query.trim().length > 0;
    const hasOrganization = state.organization.trim().length > 0;
    const hasEntityType = state.entityType.trim().length > 0;
    const title =
      hasQuery || hasOrganization || hasEntityType
        ? "Resultaten"
        : "Zoek op organisatie of onderwerp";

    currentSearchState = state;
    setSearchedState(hasQuery || hasOrganization || hasEntityType, title);
    renderState(document, resultList, "Zoeken...");

    if (updateUrl) {
      writeRouteState(currentSearchState, mode);
    }

    const params = routeStateToSearchParams({ ...state, view: "" });
    const response = await fetchImpl(`/api/search?${params.toString()}`);
    const payload = (await response.json()) as Partial<SearchResponse> & { error?: string };

    if (!response.ok) {
      throw new Error(payload.error ?? "Zoeken mislukt");
    }

    currentResults = payload.results ?? [];
    renderResults(resultList, template, currentResults, (item) => {
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
      organizationSelect,
      entityTypeSelect,
      sortSelect,
    });

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

    if (
      !nextState.query.trim() &&
      !nextState.organization.trim() &&
      !nextState.entityType.trim() &&
      !nextState.view
    ) {
      currentSearchState = nextState;
      currentResults = [];
      setSearchedState(false, "Zoek op organisatie of onderwerp");
      renderState(document, resultList, "Importeer data en zoek daarna in de GUI.");
      closeDetail({ updateUrl: false, mode: "replace" });
      return;
    }

    try {
      await runSearch(nextState, { updateUrl: false, mode: options.replace ? "replace" : "push" });
    } catch (error) {
      renderState(
        document,
        resultList,
        error instanceof Error ? error.message : "De zoekmachine reageert niet.",
      );
      setSearchedState(true, "Resultaten");
    }
  }

  closeDetailButtons.forEach((button: HTMLElement) => {
    button.addEventListener("click", () => closeDetail());
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

    try {
      await runSearch({
        query: queryInput.value.trim(),
        organization: organizationSelect.value.trim(),
        entityType: entityTypeSelect.value.trim(),
        sort: sortSelect.value.trim() || "date_desc",
        view: "",
      });
    } catch (error) {
      renderState(
        document,
        resultList,
        error instanceof Error ? error.message : "De zoekmachine reageert niet.",
      );
      setSearchedState(true, "Resultaten");
    }
  });

  fillExampleButton.addEventListener("click", async () => {
    const exampleState: SearchRouteState = {
      query: "Raadsvergadering",
      organization: "haarlem",
      entityType: "",
      sort: "date_desc",
      view: "",
    };
    applyRouteStateToForm(exampleState, {
      queryInput,
      organizationSelect,
      entityTypeSelect,
      sortSelect,
    });

    try {
      await runSearch(exampleState);
    } catch (error) {
      renderState(
        document,
        resultList,
        error instanceof Error ? error.message : "De zoekmachine reageert niet.",
      );
      setSearchedState(true, "Resultaten");
    }
  });

  setSearchedState(false, "Zoek op organisatie of onderwerp");
  renderState(document, resultList, "Importeer data en zoek daarna in de GUI.");
  await syncFromUrl({ replace: true });
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
