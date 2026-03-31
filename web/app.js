function renderState(document, resultList, message) {
  resultList.textContent = "";

  const state = document.createElement("div");
  state.className = "result-state";
  state.textContent = message;
  resultList.appendChild(state);
}

function renderResults(resultList, template, items, onSelect) {
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
    const fragment = template.content.cloneNode(true);
    const article = fragment.querySelector(".result-card");

    fragment.querySelector('[data-role="org"]').textContent = item.organization;
    fragment.querySelector('[data-role="type"]').textContent = item.entityTypeLabel;
    fragment.querySelector('[data-role="date"]').textContent = item.date;
    fragment.querySelector('[data-role="title"]').textContent = item.title;
    fragment.querySelector('[data-role="summary"]').textContent = item.summary;

    article.tabIndex = 0;
    article.setAttribute("role", "button");
    article.style.animationDelay = `${index * 70}ms`;
    article.addEventListener("click", () => onSelect(item));
    article.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onSelect(item);
      }
    });
    resultList.appendChild(fragment);
  });
}

/**
 * @param {{ document: Document; fetchImpl?: typeof fetch }} options
 */
export async function bootstrapSearchApp({ document, fetchImpl = fetch } = {}) {
  const form = document.querySelector("#search-form");
  const queryInput = document.querySelector("#query");
  const organizationSelect = document.querySelector("#organization");
  const entityTypeSelect = document.querySelector("#entity-type");
  const sortSelect = document.querySelector("#sort");
  const fillExampleButton = document.querySelector("#fill-example");
  const resultsSection = document.querySelector("#search-results");
  const resultsTitle = document.querySelector("#results-title");
  const content = document.querySelector("#content");
  const resultList = document.querySelector("#result-list");
  const template = document.querySelector("#result-template");
  const detailOverlay = document.querySelector("#detail-overlay");
  const detailTitle = document.querySelector('[data-role="detail-title"]');
  const detailOrg = document.querySelector('[data-role="detail-org"]');
  const detailType = document.querySelector('[data-role="detail-type"]');
  const detailDate = document.querySelector('[data-role="detail-date"]');
  const detailText = document.querySelector('[data-role="detail-text"]');
  const detailDownload = document.querySelector('[data-role="detail-download"]');
  const closeDetailButtons = document.querySelectorAll('[data-role="close-detail"]');

  function closeDetail() {
    detailOverlay.hidden = true;
    document.body.classList.remove("body--locked");
  }

  function openDetail(item) {
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

  closeDetailButtons.forEach((button) => {
    button.addEventListener("click", closeDetail);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !detailOverlay.hidden) {
      closeDetail();
    }
  });

  function setSearchedState(searched, title) {
    resultsSection.hidden = false;
    if (title) {
      resultsTitle.textContent = title;
    }
    content.hidden = searched;
  }

  async function runSearch(query, organization, entityType, sort) {
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
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error ?? "Zoeken mislukt");
    }

    renderResults(resultList, template, payload.results ?? [], openDetail);
  }

  form.addEventListener("submit", async (event) => {
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
    const resultList = document.querySelector("#result-list");
    if (resultList) {
      renderState(
        document,
        resultList,
        error instanceof Error ? error.message : "De zoekmachine reageert niet.",
      );
    }
  });
}
