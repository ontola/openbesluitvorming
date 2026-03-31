function renderState(document, resultList, message) {
  resultList.textContent = "";

  const state = document.createElement("div");
  state.className = "result-state";
  state.textContent = message;
  resultList.appendChild(state);
}

function renderResults(resultList, template, items) {
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
    fragment.querySelector('[data-role="date"]').textContent = item.date;
    fragment.querySelector('[data-role="title"]').textContent = item.title;
    fragment.querySelector('[data-role="summary"]').textContent = item.summary;

    article.style.animationDelay = `${index * 70}ms`;
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
  const fillExampleButton = document.querySelector("#fill-example");
  const resultsSection = document.querySelector("#search-results");
  const resultsTitle = document.querySelector("#results-title");
  const content = document.querySelector("#content");
  const resultList = document.querySelector("#result-list");
  const template = document.querySelector("#result-template");

  function setSearchedState(searched, title) {
    resultsSection.hidden = false;
    if (title) {
      resultsTitle.textContent = title;
    }
    content.hidden = searched;
  }

  async function runSearch(query, organization) {
    const hasQuery = query.trim().length > 0;
    const hasOrganization = organization.trim().length > 0;
    const title = hasQuery || hasOrganization ? "Resultaten" : "Zoek op organisatie of onderwerp";

    setSearchedState(hasQuery || hasOrganization, title);
    renderState(document, resultList, "Zoeken...");

    const params = new URLSearchParams();
    if (query.trim()) {
      params.set("query", query.trim());
    }
    if (organization.trim()) {
      params.set("organization", organization.trim());
    }

    const response = await fetchImpl(`/api/search?${params.toString()}`);
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error ?? "Zoeken mislukt");
    }

    renderResults(resultList, template, payload.results ?? []);
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
      await runSearch(queryInput.value, organizationSelect.value);
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

    try {
      await runSearch(queryInput.value, organizationSelect.value);
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
