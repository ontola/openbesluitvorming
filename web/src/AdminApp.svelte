<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type {
    AdminRunDetailResponse,
    AdminRerunRequest,
    AdminRerunResponse,
    AdminSourceOption,
    AdminRunsResponse,
    AdminSourcesResponse,
    IngestRunIssueRecord,
    IngestRunRecord,
  } from "../../src/types.ts";
  import SourcePicker from "./SourcePicker.svelte";

  const relativeTimeFormatter = new Intl.RelativeTimeFormat("nl-NL", {
    numeric: "auto",
  });

  let allSources: AdminSourceOption[] = [];
  let implementedSources: AdminSourceOption[] = [];
  let filterSources: AdminSourceOption[] = [];
  let runs: IngestRunRecord[] = [];
  let issuesByRun = new Map<string, IngestRunIssueRecord[]>();

  let filterSource = "";
  let filterStatus = "";
  let importSourceRef = "";
  let importDateTo = "";
  let importDateFrom = "";
  let importStatus = "";
  let importBusy = false;

  let detailOpen = false;
  let openRun: IngestRunRecord | null = null;
  let openIssues: IngestRunIssueRecord[] = [];
  let detailImportBusy = false;

  let pollTimer: number | null = null;

  function statusLabel(status: string): string {
    const labels: Record<string, string> = {
      running: "Draait",
      succeeded: "Geslaagd",
      partial: "Gedeeltelijk",
      failed: "Mislukt",
    };
    return labels[status] ?? status;
  }

  function statusClassName(status: string): string {
    const suffixes: Record<string, string> = {
      running: "status-running",
      succeeded: "status-succeeded",
      partial: "status-partial",
      failed: "status-failed",
    };
    return suffixes[status] ?? "status-unknown";
  }

  function triggerLabel(trigger: string): string {
    const labels: Record<string, string> = {
      user: "Gebruiker",
      scheduled: "Planner",
      manual: "Gebruiker",
      api: "Gebruiker",
    };
    return labels[trigger] ?? trigger;
  }

  function periodLabel(run: IngestRunRecord): string {
    return `${run.date_from} t/m ${run.date_to}`;
  }

  function formatRelativeTime(dateValue?: string): string {
    if (!dateValue) return "Onbekend moment";
    const target = new Date(dateValue);
    if (Number.isNaN(target.getTime())) return dateValue;

    const diffMs = target.getTime() - Date.now();
    const diffSeconds = Math.round(diffMs / 1000);
    const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
      ["year", 60 * 60 * 24 * 365],
      ["month", 60 * 60 * 24 * 30],
      ["week", 60 * 60 * 24 * 7],
      ["day", 60 * 60 * 24],
      ["hour", 60 * 60],
      ["minute", 60],
      ["second", 1],
    ];

    for (const [unit, secondsPerUnit] of units) {
      if (Math.abs(diffSeconds) >= secondsPerUnit || unit === "second") {
        return relativeTimeFormatter.format(Math.round(diffSeconds / secondsPerUnit), unit);
      }
    }

    return dateValue;
  }

  function searchUrlForRun(run: IngestRunRecord): string {
    const params = new URLSearchParams({
      organization: run.source_key,
      dateFrom: run.date_from,
      dateTo: run.date_to,
      sort: "date_desc",
    });

    return `/?${params.toString()}`;
  }

  function summarizeIssueTypes(run: IngestRunRecord): Array<{ label: string; count: number }> {
    const issues = issuesByRun.get(run.id) ?? [];
    if (issues.length === 0) return [];

    const counts = new Map<string, number>();
    for (const issue of issues) {
      counts.set(issue.step, (counts.get(issue.step) ?? 0) + 1);
    }

    return [...counts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "nl"));
  }

  function failedDocumentCount(run: IngestRunRecord): number {
    const issues = issuesByRun.get(run.id) ?? [];
    const failedDocumentIds = new Set(
      issues
        .filter((issue) =>
          issue.severity === "error" &&
          Boolean(issue.entity_id) &&
          issue.entity_id?.startsWith("document:")
        )
        .map((issue) => issue.entity_id as string),
    );

    return failedDocumentIds.size;
  }

  function formatDateInputValue(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  async function fetchJson<TPayload>(url: string, options?: RequestInit): Promise<TPayload> {
    const response = await fetch(url, options);
    const payload = (await response.json()) as TPayload & { error?: string };
    if (!response.ok) {
      throw new Error(payload.error ?? "Verzoek mislukt");
    }
    return payload;
  }

  function hasActiveRuns(items: IngestRunRecord[]): boolean {
    return items.some((run) => run.status === "running");
  }

  function schedulePolling(): void {
    if (pollTimer !== null) return;
    pollTimer = window.setInterval(() => {
      void loadRuns();
    }, 1500);
  }

  function stopPolling(): void {
    if (pollTimer === null) return;
    window.clearInterval(pollTimer);
    pollTimer = null;
  }

  function closeDetail(): void {
    detailOpen = false;
    openRun = null;
    openIssues = [];
    document.body.classList.remove("body--locked");
  }

  function openDetail(detail: AdminRunDetailResponse): void {
    openRun = detail.run;
    openIssues = detail.issues ?? [];
    detailOpen = true;
    document.body.classList.add("body--locked");
  }

  async function loadSources(): Promise<void> {
    const payload = await fetchJson<AdminSourcesResponse>("/api/admin/sources");
    allSources = payload.sources ?? [];
    implementedSources = allSources.filter((source) => source.implemented);
    filterSources = implementedSources.filter((source) => !source.isAggregate);
  }

  async function loadRuns(): Promise<void> {
    const params = new URLSearchParams();
    if (filterSource) params.set("source", filterSource);
    if (filterStatus) params.set("status", filterStatus);

    const payload = await fetchJson<AdminRunsResponse>(`/api/admin/runs?${params.toString()}`);
    runs = payload.runs ?? [];

    const nextIssues = new Map<string, IngestRunIssueRecord[]>();
    await Promise.all(
      runs.map(async (run) => {
        if (run.issue_count <= 0) {
          nextIssues.set(run.id, []);
          return;
        }

        const detail = await fetchJson<AdminRunDetailResponse>(`/api/admin/runs/${run.id}`);
        nextIssues.set(run.id, detail.issues ?? []);
      }),
    );
    issuesByRun = nextIssues;

    if (openRun) {
      const current = runs.find((run) => run.id === openRun?.id);
      if (current) {
        openRun = current;
        openIssues = issuesByRun.get(current.id) ?? [];
      } else {
        closeDetail();
      }
    }

    if (hasActiveRuns(runs)) {
      schedulePolling();
    } else {
      stopPolling();
    }
  }

  async function startImport(sourceRef: string, dateFrom: string, dateTo: string): Promise<void> {
    const payload = await fetchJson<AdminRerunResponse>("/api/admin/rerun", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceRef,
        dateFrom,
        dateTo,
      } satisfies AdminRerunRequest),
    });

    const startedRuns = payload.runs ?? [];
    if (startedRuns.length === 0) {
      importStatus = "Er zijn geen imports gestart.";
      return;
    }

    importStatus = startedRuns.length === 1
      ? `Import ${startedRuns[0].id} gestart.`
      : `${startedRuns.length} imports gestart.`;
    runs = [...startedRuns, ...runs];
    issuesByRun = new Map(issuesByRun);
    for (const run of startedRuns) {
      issuesByRun.set(run.id, []);
    }
    schedulePolling();
    await loadRuns();
  }

  async function submitImport(): Promise<void> {
    const selected = allSources.find((source) => source.sourceRef === importSourceRef) ?? null;
    if (!selected) {
      importStatus = "Kies eerst een bron uit de suggesties.";
      return;
    }
    if (!selected.implemented) {
      importStatus = "Deze bron is nog niet ondersteund in Woozi.";
      return;
    }
    if (!importDateFrom.trim() || !importDateTo.trim()) {
      importStatus = "Vul zowel een start- als einddatum in.";
      return;
    }
    if (importDateFrom > importDateTo) {
      importStatus = "De startdatum moet op of voor de einddatum liggen.";
      return;
    }

    importBusy = true;
    importStatus = "Import gestart...";
    try {
      await startImport(importSourceRef, importDateFrom, importDateTo);
    } catch (error) {
      importStatus = error instanceof Error ? error.message : "Import mislukt.";
    } finally {
      importBusy = false;
    }
  }

  async function importOpenRunAgain(): Promise<void> {
    if (!openRun) return;
    detailImportBusy = true;
    importStatus = "Import gestart...";
    try {
      const source = allSources.find((item) => item.key === openRun?.source_key);
      const sourceRef = source?.sourceRef ?? openRun.source_key;
      await startImport(sourceRef, openRun.date_from, openRun.date_to);
      const run = runs.find((item) => item.source_key === openRun?.source_key && item.date_from === openRun?.date_from && item.date_to === openRun?.date_to && item.status === "running") ?? runs[0];
      if (run) {
        openRun = run;
        openIssues = issuesByRun.get(run.id) ?? [];
      }
    } catch (error) {
      importStatus = error instanceof Error ? error.message : "Import mislukt.";
    } finally {
      detailImportBusy = false;
    }
  }

  function handleEscape(event: KeyboardEvent): void {
    if (event.key === "Escape" && detailOpen) {
      closeDetail();
    }
  }

  $: filteredSourceOptions = implementedSources;

  onMount(async () => {
    importDateTo = formatDateInputValue(new Date());
    const lastWeek = new Date();
    lastWeek.setDate(lastWeek.getDate() - 7);
    importDateFrom = formatDateInputValue(lastWeek);

    await loadSources();
    await loadRuns();
    document.addEventListener("keydown", handleEscape);
  });

  onDestroy(() => {
    stopPolling();
    document.removeEventListener("keydown", handleEscape);
  });
</script>

<div class="page-shell">
  <main class="content content--admin">
    <section class="section">
      <a class="admin-back-link" href="/">← Terug naar zoeken</a>
      <div class="section__heading">
        <h2>Admin</h2>
      </div>
    </section>

    <section class="section">
      <div class="section__heading">
        <h2>Import starten</h2>
      </div>
      <form
        class="admin-form admin-form--rerun"
        on:submit|preventDefault={() => {
          void submitImport();
        }}
      >
        <SourcePicker
          options={allSources}
          bind:value={importSourceRef}
          placeholder="Zoek bron, leverancier of bestuurslaag..."
          valueSelector={(source) => source.sourceRef}
          subtitle={(source) =>
            `${source.supplier} · ${source.organizationType}${source.implemented ? "" : " · nog niet ondersteund"}`}
        />
        <label class="search-field admin-field">
          <input bind:value={importDateFrom} type="date" />
        </label>
        <label class="search-field admin-field">
          <input bind:value={importDateTo} type="date" />
        </label>
        <button type="submit" class="primary-button" disabled={importBusy}>Import uitvoeren</button>
      </form>
      <p class="admin-status">{importStatus}</p>
    </section>

    <section class="section">
      <div class="section__heading admin-section-heading">
        <h2>Recente imports</h2>
      </div>
      <div class="admin-form admin-form--filters">
        <label class="select-field select-field--compact">
          <span class="sr-only">Filter bron</span>
          <select bind:value={filterSource} on:change={() => void loadRuns()}>
            <option value="">Alle bronnen</option>
            {#each filterSources as source}
              <option value={source.key}>{source.label}</option>
            {/each}
          </select>
        </label>
        <label class="select-field select-field--compact">
          <span class="sr-only">Filter status</span>
          <select bind:value={filterStatus} on:change={() => void loadRuns()}>
            <option value="">Alle statussen</option>
            <option value="running">Draait</option>
            <option value="succeeded">Geslaagd</option>
            <option value="partial">Gedeeltelijk</option>
            <option value="failed">Mislukt</option>
          </select>
        </label>
        <button type="button" class="ghost-button" on:click={() => void loadRuns()}>Verversen</button>
      </div>
      <div class="admin-runs-table" aria-hidden="true">
        <div>Import</div>
        <div>Verg.</div>
        <div>Doc.</div>
        <div>Fout</div>
        <div>Cache</div>
        <div>Download</div>
        <div>Tijd</div>
      </div>
      <div class="admin-runs">
        {#if runs.length === 0}
          <div class="result-state">Nog geen imports gevonden.</div>
        {:else}
          {#each runs as run}
            <button
              type="button"
              class="surface-card admin-run"
              on:click={() => openDetail({ run, issues: issuesByRun.get(run.id) ?? [] })}
            >
              <div class="admin-run__row">
                <div class="admin-run__primary">
                  <div class="admin-run__meta">
                    <span class="pill">{run.source_key}</span>
                    <span class={`pill pill--soft ${statusClassName(run.status)}`}>
                      {statusLabel(run.status)}
                    </span>
                    {#if run.trigger === "scheduled"}
                      <span class="pill pill--soft">Planner</span>
                    {/if}
                    <span class="admin-run__date">{periodLabel(run)}</span>
                  </div>
                </div>
                <div class="admin-run__metric"><strong>{run.meeting_count}</strong></div>
                <div class="admin-run__metric"><strong>{run.document_count}</strong></div>
                <div class="admin-run__metric"><strong>{failedDocumentCount(run)}</strong></div>
                <div class="admin-run__metric"><strong>{run.cache_hits}</strong></div>
                <div class="admin-run__metric"><strong>{run.downloaded_count}</strong></div>
                <div class="admin-run__time">
                  <small title={run.started_at}>{formatRelativeTime(run.started_at)}</small>
                </div>
              </div>

              {#if summarizeIssueTypes(run).length > 0}
                <div class="admin-run__issue">
                  <strong>{run.issue_count} issue{run.issue_count === 1 ? "" : "s"}</strong>
                  <div class="admin-run__issue-list">
                    {#each summarizeIssueTypes(run) as issue}
                      <span class="admin-run__issue-chip">
                        <span class="admin-run__issue-count">{issue.count}×</span> {issue.label}
                      </span>
                    {/each}
                  </div>
                </div>
              {/if}
            </button>
          {/each}
        {/if}
      </div>
    </section>
  </main>
</div>

{#if detailOpen && openRun}
  <section class="detail-overlay">
    <button
      type="button"
      class="detail-overlay__backdrop"
      aria-label="Sluiten"
      on:click={closeDetail}
    ></button>
    <div
      class="detail-sheet admin-detail-sheet"
      aria-modal="true"
      aria-labelledby="admin-detail-title"
      role="dialog"
    >
      <div class="detail-sheet__header">
        <div class="detail-sheet__meta">
          <span class="pill">{openRun.source_key}</span>
          <span class={`pill pill--soft ${statusClassName(openRun.status)}`}>
            {statusLabel(openRun.status)}
          </span>
          <span class="detail-sheet__date">{periodLabel(openRun)}</span>
        </div>
        <div class="detail-sheet__header-actions">
          <a class="ghost-button detail-sheet__download" href={searchUrlForRun(openRun)}>
            Bekijk resultaten
          </a>
          <button
            class="primary-button detail-sheet__download"
            type="button"
            disabled={detailImportBusy}
            on:click={() => {
              void importOpenRunAgain();
            }}
          >
            Import uitvoeren
          </button>
          <button class="detail-sheet__close" type="button" on:click={closeDetail}>
            Sluiten
          </button>
        </div>
      </div>
      <div class="detail-sheet__body">
        <div class="admin-detail">
          <div class="admin-detail__grid">
            <div><strong>Import-ID</strong><p>{openRun.id}</p></div>
            <div><strong>Bron</strong><p>{openRun.source_key}</p></div>
            <div><strong>Gestart door</strong><p>{triggerLabel(openRun.trigger)}</p></div>
            <div><strong>Status</strong><p>{statusLabel(openRun.status)}</p></div>
            <div><strong>Periode</strong><p>{periodLabel(openRun)}</p></div>
            <div><strong>Gestart</strong><p>{openRun.started_at}</p></div>
            <div><strong>Vergaderingen</strong><p>{openRun.meeting_count}</p></div>
            <div><strong>Documenten</strong><p>{openRun.document_count}</p></div>
            <div><strong>Documentfouten</strong><p>{failedDocumentCount(openRun)}</p></div>
            <div><strong>Cache hits</strong><p>{openRun.cache_hits}</p></div>
            <div><strong>Downloads</strong><p>{openRun.downloaded_count}</p></div>
            <div><strong>Issues</strong><p>{openRun.issue_count}</p></div>
          </div>

          <div class="admin-detail__issues">
            <h3>Issues</h3>
            {#if openIssues.length > 0}
              <ul>
                {#each openIssues as issue}
                  <li>
                    <strong>{issue.step}</strong>
                    {#if issue.entity_id} ({issue.entity_id}){/if}: {issue.message}
                    {#if issue.details}
                      <details class="admin-issue-details">
                        <summary>Volledige fout</summary>
                        <pre>{issue.details}</pre>
                      </details>
                    {/if}
                  </li>
                {/each}
              </ul>
            {:else}
              <p>Geen issues geregistreerd.</p>
            {/if}
          </div>
        </div>
      </div>
    </div>
  </section>
{/if}
