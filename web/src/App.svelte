<script lang="ts">
  import { marked } from "marked";
  import { onDestroy, onMount, tick } from "svelte";
  import type {
    AdminSourceOption,
    AdminSourcesResponse,
    EntityContentResponse,
    SearchResponse,
    SearchResult,
  } from "../../src/types.ts";
  import SourcePicker from "./SourcePicker.svelte";

  type SearchRouteState = {
    query: string;
    organization: string;
    entityType: string;
    sort: string;
    dateFrom: string;
    dateTo: string;
    view: string;
  };

  let query = "";
  let organization = "";
  let entityType = "";
  let sort = "date_desc";
  let dateFrom = "";
  let dateTo = "";
  let view = "";

  let sources: AdminSourceOption[] = [];
  let results: SearchResult[] = [];
  let loading = false;
  let searched = false;
  let filtersOpen = false;
  let searchRequestId = 0;

  let detailOpen = false;
  let detailLoading = false;
  let detailItem: SearchResult | null = null;
  let detailContent: EntityContentResponse | null = null;
  let detailMode: "text" | "pdf" = "text";
  let detailPdfFailed = false;

  const detailCache = new Map<string, EntityContentResponse | null>();

  let queryInputEl: HTMLInputElement | null = null;
  let detailTextEl: HTMLElement | null = null;
  let debounceTimer: number | undefined;

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

  function routeStateToSearchParams(state: SearchRouteState): URLSearchParams {
    const params = new URLSearchParams();
    if (state.query) params.set("query", state.query);
    if (state.organization) params.set("organization", state.organization);
    if (state.entityType) params.set("entityType", state.entityType);
    if (state.sort) params.set("sort", state.sort);
    if (state.dateFrom) params.set("dateFrom", state.dateFrom);
    if (state.dateTo) params.set("dateTo", state.dateTo);
    if (state.view) params.set("view", state.view);
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

  function clearToHome(mode: "push" | "replace" = "push"): void {
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
    focusQuery();
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
    detailOpen = false;
    detailLoading = false;
    detailItem = null;
    detailContent = null;
    detailMode = "text";
    detailPdfFailed = false;
    document.body.classList.remove("body--locked");
    if (updateUrl && view) {
      view = "";
      writeRouteState();
    }
  }

  async function loadDetailContent(entityId: string): Promise<EntityContentResponse | null> {
    if (detailCache.has(entityId)) {
      return detailCache.get(entityId) ?? null;
    }

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
  }

  async function syncDetailText(): Promise<void> {
    if (detailMode !== "text" || !detailTextEl) return;
    await tick();
    if (!detailTextEl) return;
    highlightElementText(detailTextEl, query);
    const firstMatch = detailTextEl.querySelector<HTMLElement>("mark");
    if (firstMatch) {
      firstMatch.scrollIntoView({ block: "center", behavior: "smooth" });
    } else {
      detailTextEl.scrollTop = 0;
    }
  }

  async function openDetail(item: SearchResult, updateUrl = true): Promise<void> {
    detailItem = item;
    detailLoading = true;
    detailOpen = true;
    detailContent = null;
    detailMode = "text";
    detailPdfFailed = false;
    document.body.classList.add("body--locked");

    if (updateUrl && view !== item.entityId) {
      view = item.entityId;
      writeRouteState();
    }

    const content = await loadDetailContent(item.entityId);
    if (view && view !== item.entityId) return;

    detailContent = content;
    detailLoading = false;
    const hasPdf = Boolean(content?.pdfUrl);
    detailMode = !content?.markdownText?.trim() && hasPdf ? "pdf" : "text";

    if (detailMode === "text") {
      await syncDetailText();
    }
  }

  async function runSearch(mode: "push" | "replace" = "push"): Promise<void> {
    const hasFilters = hasActiveSearchFilters();
    searched = hasFilters;

    if (!hasFilters) {
      results = [];
      closeDetail(false);
      if (mode) writeRouteState(mode);
      return;
    }

    loading = true;
    if (mode) writeRouteState(mode);
    const requestId = ++searchRequestId;

    try {
      const params = routeStateToSearchParams({ ...currentRouteState(), view: "" });
      const payload = await fetchJson<SearchResponse>(`/api/search?${params.toString()}`);
      if (requestId !== searchRequestId) return;
      results = payload.results ?? [];

      if (view) {
        const selected = results.find((item) => item.entityId === view);
        if (selected) {
          await openDetail(selected, false);
        } else {
          closeDetail(false);
        }
      } else {
        closeDetail(false);
      }
    } catch {
      if (requestId === searchRequestId) {
        results = [];
      }
    } finally {
      if (requestId === searchRequestId) {
        loading = false;
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
    if (!query.trim()) {
      if (!organization && !entityType && !dateFrom && !dateTo) {
        clearToHome("replace");
        return;
      }
      void runSearch("replace");
      return;
    }
    scheduleSearch();
  }

  function onQuerySearch(): void {
    if (!query.trim() && !organization && !entityType && !dateFrom && !dateTo) {
      clearToHome("replace");
      return;
    }
    void runSearch("replace");
  }

  function onFilterChange(): void {
    if (debounceTimer) {
      window.clearTimeout(debounceTimer);
      debounceTimer = undefined;
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
    filtersOpen = hasAdvancedSearchFilters();
  }

  async function syncFromUrl(replace = false): Promise<void> {
    const nextState = routeStateFromUrl(new URL(window.location.href));
    applyState(nextState);

    if (!hasActiveSearchFilters() && !view) {
      searched = false;
      results = [];
      closeDetail(false);
      focusQuery();
      return;
    }

    await runSearch(replace ? "replace" : "push");
  }

  function handlePopstate(): void {
    void syncFromUrl(true);
  }

  function handleEscape(event: KeyboardEvent): void {
    if (event.key === "Escape" && detailOpen) {
      closeDetail();
    }
  }

  onMount(async () => {
    await loadSources();
    await syncFromUrl(true);
    document.addEventListener("keydown", handleEscape);
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
  });

  $: if (detailOpen && detailMode === "text" && detailContent) {
    void syncDetailText();
  }

  $: resultsTitle = !searched
    ? "Zoek op organisatie of onderwerp"
    : loading
      ? "Zoeken..."
      : `Resultaten (${results.length})`;
  $: selectedSource = sources.find((source) => source.key === organization) ?? null;
  $: detailMarkdownHtml = renderMarkdown(detailContent?.markdownText);
  $: detailPdfUrl = detailContent?.pdfUrl ? pdfViewerUrl(detailContent.pdfUrl) : "";
</script>

<svelte:window on:popstate={handlePopstate} />

<div class="page-shell">
  <header class="hero">
    <div class="hero__glow hero__glow--left"></div>
    <div class="hero__glow hero__glow--right"></div>
    <p class="hero__admin-link"><a href="/admin.html">Admin</a></p>
    <h1 class="brand">
      <a
        class="brand__link"
        href="/"
        on:click|preventDefault={() => clearToHome()}
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

    <form
      class="search-panel"
      on:submit|preventDefault={() => {
        void runSearch();
      }}
    >
      <div class="search-panel__query-row">
        <label class="search-field search-field--primary">
          <input
            bind:this={queryInputEl}
            bind:value={query}
            name="query"
            type="search"
            placeholder="Zoeken naar moties, agenda's, toezeggingen of besluiten..."
            autocomplete="off"
            on:input={onQueryInput}
            on:search={onQuerySearch}
          />
        </label>
        <button type="submit" class="primary-button search-panel__submit">Doorzoeken</button>
      </div>

      <div class="search-panel__actions">
        <button
          type="button"
          class="ghost-button ghost-button--subtle search-panel__toggle"
          aria-expanded={filtersOpen}
          on:click={() => {
            filtersOpen = !filtersOpen;
          }}
        >
          {filtersOpen ? "Filters verbergen" : "Filters tonen"}
        </button>
      </div>

      {#if filtersOpen}
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
        </div>
      {/if}
    </form>

    {#if searched}
      <section class="search-results search-results--hero" aria-live="polite">
        <div class="search-results__heading">
          <div class="search-results__title-group">
            <h2 class="search-results__title">{resultsTitle}</h2>
          </div>
          <label class="select-field select-field--compact search-results__sort">
            <span class="sr-only">Sorteren</span>
            <select bind:value={sort} name="sort" on:change={() => void runSearch("replace")}>
              <option value="date_desc">Nieuwste eerst</option>
              <option value="date_asc">Oudste eerst</option>
              <option value="title_asc">Titel A-Z</option>
            </select>
          </label>
        </div>

        <div class:result-list--loading={loading} class="result-list" aria-busy={loading}>
          {#if results.length === 0 && !loading}
            <div class="result-state">Geen resultaten gevonden voor deze zoekopdracht.</div>
          {:else}
            {#each results as item, index}
              <button
                type="button"
                class="surface-card surface-card--lift result-card"
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
          {/if}
        </div>
      </section>
    {/if}
  </header>

  {#if !searched}
    <main class="content">
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
  <section class="detail-overlay">
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
    >
      <div class="detail-sheet__header">
        <div class="detail-sheet__header-bar">
          <div class="detail-sheet__meta">
            <span class="pill">{detailItem.organization}</span>
            <span class="pill pill--soft">{detailItem.entityTypeLabel}</span>
            <span class="detail-sheet__date">{detailItem.date}</span>

            {#if detailContent?.pdfUrl}
              <div class="detail-sheet__view-switch">
                <button
                  type="button"
                  class="detail-sheet__view-toggle"
                  aria-pressed={detailMode === "text"}
                  on:click={async () => {
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
                    detailMode = "pdf";
                  }}
                >
                  PDF
                </button>
              </div>
            {/if}
          </div>

          <div class="detail-sheet__header-actions">
            {#if detailContent?.downloadUrl || detailItem.downloadUrl}
              <a
                class="primary-button detail-sheet__download"
                href={detailContent?.downloadUrl ?? detailItem.downloadUrl}
                aria-label="Download"
                download
              >
                <span class="detail-sheet__action-icon" aria-hidden="true">↓</span>
                <span class="detail-sheet__action-label">Download</span>
              </a>
            {/if}
            <button
              class="detail-sheet__close"
              type="button"
              aria-label="Sluiten"
              on:click={() => closeDetail()}
            >
              <span class="detail-sheet__action-icon" aria-hidden="true">×</span>
              <span class="detail-sheet__action-label">Sluiten</span>
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
            <iframe
              class="detail-sheet__pdf-frame"
              title="PDF-weergave"
              src={detailPdfUrl}
              on:error={() => {
                detailPdfFailed = true;
              }}
            ></iframe>
            {#if detailPdfFailed}
              <p class="detail-sheet__pdf-fallback">
                De ingebouwde PDF-weergave kon niet worden geladen.
                <a href={detailContent?.pdfUrl} target="_blank" rel="noopener">Open PDF in nieuw tabblad</a>
              </p>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </section>
{/if}
