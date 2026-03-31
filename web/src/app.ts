/// <reference lib="dom" />

import type { SearchResponse, SearchResult } from "../../src/types.ts";

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
    summary.textContent = item.summary;

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

export async function bootstrapSearchApp({
  document,
  fetchImpl = fetch,
}: {
  document: Document;
  fetchImpl?: typeof fetch;
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

  function closeDetail(): void {
    detailOverlay.hidden = true;
    document.body.classList.remove("body--locked");
  }

  function openDetail(item: SearchResult): void {
    detailTitle.textContent = item.title;
    detailOrg.textContent = item.organization;
    detailType.textContent = item.entityTypeLabel;
    detailDate.textContent = item.date;
    detailText.textContent = item.fullText;

    if (item.downloadUrl) {
      detailDownload.hidden = false;
      detailDownload.href = item.downloadUrl;
    } else {
      detailDownload.hidden = true;
      detailDownload.removeAttribute("href");
    }

    detailOverlay.hidden = false;
    document.body.classList.add("body--locked");
  }

  closeDetailButtons.forEach((button: HTMLElement) => {
    button.addEventListener("click", closeDetail);
  });

  document.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape" && !detailOverlay.hidden) {
      closeDetail();
    }
  });

  function setSearchedState(searched: boolean, title: string): void {
    resultsSection.hidden = false;
    resultsTitle.textContent = title;
    content.hidden = searched;
  }

  async function runSearch(
    query: string,
    organization: string,
    entityType: string,
    sort: string,
  ): Promise<void> {
    const hasQuery = query.trim().length > 0;
    const hasOrganization = organization.trim().length > 0;
    const hasEntityType = entityType.trim().length > 0;
    const title =
      hasQuery || hasOrganization || hasEntityType
        ? "Resultaten"
        : "Zoek op organisatie of onderwerp";

    setSearchedState(hasQuery || hasOrganization || hasEntityType, title);
    renderState(document, resultList, "Zoeken...");

    const params = new URLSearchParams();
    if (query.trim()) {
      params.set("query", query.trim());
    }
    if (organization.trim()) {
      params.set("organization", organization.trim());
    }
    if (entityType.trim()) {
      params.set("entityType", entityType.trim());
    }
    if (sort.trim()) {
      params.set("sort", sort.trim());
    }

    const response = await fetchImpl(`/api/search?${params.toString()}`);
    const payload = (await response.json()) as Partial<SearchResponse> & { error?: string };

    if (!response.ok) {
      throw new Error(payload.error ?? "Zoeken mislukt");
    }

    renderResults(resultList, template, payload.results ?? [], openDetail);
  }

  form.addEventListener("submit", async (event: SubmitEvent) => {
    event.preventDefault();

    try {
      await runSearch(
        queryInput.value,
        organizationSelect.value,
        entityTypeSelect.value,
        sortSelect.value,
      );
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
    queryInput.value = "Raadsvergadering";
    organizationSelect.value = "haarlem";
    entityTypeSelect.value = "";
    sortSelect.value = "date_desc";

    try {
      await runSearch(
        queryInput.value,
        organizationSelect.value,
        entityTypeSelect.value,
        sortSelect.value,
      );
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
