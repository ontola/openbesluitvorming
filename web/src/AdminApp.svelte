<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type {
    AdminCoverageResponse,
    AdminCoverageRow,
    AdminRunDetailResponse,
    AdminRerunRequest,
    AdminRerunResponse,
    AdminRunSummary,
    AdminRunSummaryResponse,
    AdminSourceOption,
    AdminRunsResponse,
    AdminSourcesResponse,
    IngestExecutionMode,
    IngestRunIssueRecord,
    IngestRunRecord,
  } from "../../src/types.ts";
  import CoverageHeatmapRow from "./CoverageHeatmapRow.svelte";
  import SourcePicker from "./SourcePicker.svelte";

  type ExecutionModeOption = {
    value: IngestExecutionMode;
    label: string;
    description: string;
    available: boolean;
    availabilityNote?: string;
  };

  const relativeTimeFormatter = new Intl.RelativeTimeFormat("nl-NL", {
    numeric: "auto",
  });

  let allSources: AdminSourceOption[] = [];
  let implementedSources: AdminSourceOption[] = [];
  let filterSources: AdminSourceOption[] = [];
  let runs: IngestRunRecord[] = [];
  let runSummary: AdminRunSummary | null = null;
  let coverageRows: AdminCoverageRow[] = [];
  let coverageMonths: string[] = [];
  let coverageMaxDocuments = 0;
  let issuesByRun = new Map<string, IngestRunIssueRecord[]>();
  let runsHasMore = false;
  let runsBusy = false;
  let loadingOlderRuns = false;
  let coverageBusy = false;
  let bootLoading = true;
  let bootError = "";

  let coverageMonthCount = "60";
  let coverageOpen = false;

  type ExtractorWorker = {
    url: string;
    status: "ok" | "unreachable";
    requests_total?: number;
    requests_failed?: number;
    uptime_seconds?: number;
    load_1m?: number;
    load_5m?: number;
  };
  let extractorWorkers: ExtractorWorker[] = [];
  let extractorsLoaded = false;
  let coverageLoaded = false;
  let coverageRangeAnchor: { sourceKey: string; month: string } | null = null;
  let coverageRangeHoverMonth = "";
  let coverageSelectedRange: { sourceKey: string; startMonth: string; endMonth: string } | null = null;
  let coverageGrouping: "alphabetical" | "supplier" | "type" = "alphabetical";
  let coverageGroups: Array<{ key: string; label: string; rows: AdminCoverageRow[] }> = [];

  const RUNS_PAGE_SIZE = 50;

  let filterSource = "";
  let filterStatus = "";
  let importSourceRef = "";
  let importDateTo = "";
  let importDateFrom = "";
  let importExecutionMode: IngestExecutionMode = "full";
  let importStatus = "";
  let importBusy = false;

  let detailOpen = false;
  let openRun: IngestRunRecord | null = null;
  let openIssues: IngestRunIssueRecord[] = [];
  let detailImportBusy = false;
  let retryExecutionMode: IngestExecutionMode = "full";

  let pollTimer: number | null = null;

  const executionModeOptions: ExecutionModeOption[] = [
    {
      value: "full",
      label: "Bron-API verversen",
      description:
        "Haalt bron-API's opnieuw op, bouwt meetings en documenten opnieuw op, hergebruikt bestaande downloads en afleidingen waar mogelijk, en indexeert daarna opnieuw.",
      available: true,
    },
    {
      value: "rederive_cached",
      label: "Herleid uit opslag",
      description:
        "Gebruikt opgeslagen bronbestanden om markdown en paginachunks opnieuw af te leiden en daarna opnieuw te indexeren. De bron-API wordt nu nog wel geraadpleegd om de documentset opnieuw vast te stellen.",
      available: true,
    },
    {
      value: "reindex_only",
      label: "Alleen herindexeren",
      description:
        "Zou alleen de zoekprojectie opnieuw moeten opbouwen zonder bron-API's of parserstap opnieuw uit te voeren.",
      available: false,
      availabilityNote:
        "Nog niet beschikbaar: hiervoor ontbreekt nog een replaybare opslag van entities buiten Quickwit.",
    },
    {
      value: "retry_failed_documents",
      label: "Alleen mislukte documenten",
      description:
        "Zou alleen documentdownload- en extractiefouten uit een eerdere run opnieuw moeten uitvoeren.",
      available: false,
      availabilityNote:
        "Nog niet beschikbaar: hiervoor ontbreekt nog een gerichte retry-pad op documentniveau.",
    },
  ];

  function statusLabel(status: string): string {
    const labels: Record<string, string> = {
      queued: "Wacht",
      running: "Draait",
      succeeded: "Geslaagd",
      partial: "Gedeeltelijk",
      failed: "Mislukt",
    };
    return labels[status] ?? status;
  }

  function statusClassName(status: string): string {
    const suffixes: Record<string, string> = {
      queued: "status-queued",
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

  function executionModeLabel(mode: IngestExecutionMode): string {
    return executionModeOption(mode)?.label ?? mode;
  }

  function executionModeOption(mode: IngestExecutionMode): ExecutionModeOption | undefined {
    return executionModeOptions.find((option) => option.value === mode);
  }

  function executionModeDescription(mode: IngestExecutionMode): string {
    const option = executionModeOption(mode);
    if (!option) {
      return mode;
    }

    return option.availabilityNote
      ? `${option.description} ${option.availabilityNote}`
      : option.description;
  }

  function isAggregateSourceRef(sourceRef: string): boolean {
    return sourceRef.startsWith("__supplier__:");
  }

  function isExecutionModeSelectable(mode: IngestExecutionMode, sourceRef = ""): boolean {
    const option = executionModeOption(mode);
    if (!option?.available) {
      return false;
    }

    if (sourceRef && isAggregateSourceRef(sourceRef) && mode !== "full") {
      return false;
    }

    return true;
  }

  function executionModeAvailabilityNote(mode: IngestExecutionMode, sourceRef = ""): string | null {
    const option = executionModeOption(mode);
    if (!option) {
      return null;
    }

    if (!option.available) {
      return option.availabilityNote ?? "Nog niet beschikbaar.";
    }

    if (sourceRef && isAggregateSourceRef(sourceRef) && mode !== "full") {
      return "Nog niet beschikbaar voor leverancier-brede imports; kies eerst een individuele bron.";
    }

    return null;
  }

  function supplierLabel(supplier: string): string {
    const labels: Record<string, string> = {
      notubiz: "Notubiz",
      ibabs: "iBabs",
    };

    return labels[supplier] ?? supplier;
  }

  function toggleCoverage(): void {
    coverageOpen = !coverageOpen;
    if (coverageOpen && !coverageLoaded && !coverageBusy) {
      void loadCoverage();
    }
  }

  function organizationTypeLabel(type: string): string {
    const labels: Record<string, string> = {
      gemeente: "Gemeenten",
      provincie: "Provincies",
      waterschap: "Waterschappen",
    };

    return labels[type] ?? type;
  }

  function coverageGroupingLabel(grouping: typeof coverageGrouping): string {
    const labels: Record<typeof coverageGrouping, string> = {
      alphabetical: "Alfabetisch",
      supplier: "Per leverancier",
      type: "Per bestuurslaag",
    };

    return labels[grouping];
  }

  $: coverageGroups = (() => {
    if (coverageGrouping === "alphabetical") {
      return [{
        key: "alphabetical",
        label: coverageGroupingLabel("alphabetical"),
        rows: [...coverageRows].sort((left, right) => left.label.localeCompare(right.label, "nl")),
      }];
    }

    const grouped = coverageRows.reduce<Record<string, AdminCoverageRow[]>>((groups, row) => {
      const key = coverageGrouping === "supplier" ? row.supplier : row.organizationType;
      (groups[key] ??= []).push(row);
      return groups;
    }, {});

    return Object.entries(grouped)
      .map(([key, rows]) => ({
        key,
        label: coverageGrouping === "supplier" ? supplierLabel(key) : organizationTypeLabel(key),
        rows: [...rows].sort((left, right) => left.label.localeCompare(right.label, "nl")),
      }))
      .sort((left, right) => left.label.localeCompare(right.label, "nl"));
  })();

  function periodLabel(run: IngestRunRecord): string {
    return `${run.date_from} t/m ${run.date_to}`;
  }

  function compactRunLabel(run?: IngestRunRecord): string {
    if (!run) return "Geen";
    return `${run.source_key} · ${periodLabel(run)}`;
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

  function formatRunDuration(run: Pick<IngestRunRecord, "started_at" | "finished_at">): string {
    const startedAt = Date.parse(run.started_at);
    if (Number.isNaN(startedAt)) {
      return "Onbekend";
    }

    const endedAt = run.finished_at ? Date.parse(run.finished_at) : Date.now();
    if (Number.isNaN(endedAt)) {
      return "Onbekend";
    }

    const totalSeconds = Math.max(0, Math.round((endedAt - startedAt) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}u ${String(minutes).padStart(2, "0")}m`;
    }

    if (minutes > 0) {
      return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
    }

    return `${seconds}s`;
  }

  function formatDateCell(dateValue?: string): string {
    if (!dateValue) return "Onbekend";
    const date = new Date(`${dateValue}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return dateValue;
    return date.toLocaleDateString("nl-NL", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: "UTC",
    });
  }

  function monthLabel(month: string): string {
    const date = new Date(`${month}T00:00:00Z`);
    return date.toLocaleDateString("nl-NL", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  }

  function compactMonthLabel(month: string): string {
    const date = new Date(`${month}T00:00:00Z`);
    return date.toLocaleDateString("nl-NL", {
      month: "short",
      year: coverageMonths.length > 24 ? "2-digit" : undefined,
      timeZone: "UTC",
    });
  }

  function coverageIntensity(documentCount: number): number {
    if (documentCount <= 0 || coverageMaxDocuments <= 0) return 0;
    return Math.max(0.18, Math.min(1, documentCount / coverageMaxDocuments));
  }

  function coverageTooltip(
    sourceLabel: string,
    month: string,
    cell: AdminCoverageRow["months"][number],
  ): string {
    if (cell.documentCount <= 0) {
      return `${sourceLabel} · ${monthLabel(month)} · geen documenten geïndexeerd`;
    }

    return [
      sourceLabel,
      monthLabel(month),
      `${cell.documentCount} documenten`,
    ].filter(Boolean).join(" · ");
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

  function applyCoverageSourceSelection(sourceKey: string): boolean {
    const source = allSources.find((candidate) => candidate.key === sourceKey);
    if (!source) {
      return false;
    }

    importSourceRef = source.sourceRef;
    importStatus = "";
    return true;
  }

  function selectCoverageSource(sourceKey: string): void {
    if (!applyCoverageSourceSelection(sourceKey)) {
      return;
    }

    coverageRangeAnchor = null;
    coverageRangeHoverMonth = "";
    coverageSelectedRange = null;
  }

  function coverageMonthStart(month: string): string {
    return `${month}-01`;
  }

  function coverageMonthEnd(month: string): string {
    const [yearValue, monthValue] = month.split("-").map(Number);
    const end = new Date(Date.UTC(yearValue, monthValue, 0));
    const year = end.getUTCFullYear();
    const normalizedMonth = String(end.getUTCMonth() + 1).padStart(2, "0");
    const day = String(end.getUTCDate()).padStart(2, "0");
    return `${year}-${normalizedMonth}-${day}`;
  }

  function monthRangeBounds(left: string, right: string): [string, string] {
    return left <= right ? [left, right] : [right, left];
  }

  function isCoverageCellInRange(sourceKey: string, month: string): boolean {
    if (!coverageRangeAnchor || coverageRangeAnchor.sourceKey !== sourceKey) {
      return false;
    }

    const rangeEnd = coverageRangeHoverMonth || coverageRangeAnchor.month;
    const [startMonth, endMonth] = monthRangeBounds(coverageRangeAnchor.month, rangeEnd);
    return month >= startMonth && month <= endMonth;
  }

  function isCoverageCellAnchor(sourceKey: string, month: string): boolean {
    return coverageRangeAnchor?.sourceKey === sourceKey && coverageRangeAnchor.month === month;
  }

  function isCoverageCellSelected(sourceKey: string, month: string): boolean {
    if (!coverageSelectedRange || coverageSelectedRange.sourceKey !== sourceKey) {
      return false;
    }

    return month >= coverageSelectedRange.startMonth && month <= coverageSelectedRange.endMonth;
  }

  function previewCoverageRange(sourceKey: string, month: string): void {
    if (!coverageRangeAnchor || coverageRangeAnchor.sourceKey !== sourceKey) {
      return;
    }

    coverageRangeHoverMonth = month;
  }

  function clearCoverageRangePreview(sourceKey?: string): void {
    if (!coverageRangeAnchor) {
      return;
    }

    if (!sourceKey || coverageRangeAnchor.sourceKey === sourceKey) {
      coverageRangeHoverMonth = "";
    }
  }

  function coveragePreviewRangeForSource(
    sourceKey: string,
  ): { startMonth: string; endMonth: string } | null {
    if (!coverageRangeAnchor || coverageRangeAnchor.sourceKey !== sourceKey) {
      return null;
    }

    const rangeEnd = coverageRangeHoverMonth || coverageRangeAnchor.month;
    const [startMonth, endMonth] = monthRangeBounds(coverageRangeAnchor.month, rangeEnd);
    return { startMonth, endMonth };
  }

  function coverageSelectedSourceLabel(): string {
    if (!coverageSelectedRange) {
      return "";
    }

    return coverageRows.find((row) => row.sourceKey === coverageSelectedRange.sourceKey)?.label ??
      coverageSelectedRange.sourceKey;
  }

  function selectCoverageCell(sourceKey: string, month: string): void {
    if (!applyCoverageSourceSelection(sourceKey)) {
      return;
    }

    if (!coverageRangeAnchor || coverageRangeAnchor.sourceKey !== sourceKey) {
      coverageRangeAnchor = { sourceKey, month };
      coverageRangeHoverMonth = "";
      importDateFrom = coverageMonthStart(month);
      importDateTo = coverageMonthEnd(month);
      return;
    }

    const [startMonth, endMonth] = monthRangeBounds(coverageRangeAnchor.month, month);
    importDateFrom = coverageMonthStart(startMonth);
    importDateTo = coverageMonthEnd(endMonth);
    coverageSelectedRange = {
      sourceKey,
      startMonth,
      endMonth,
    };
    coverageRangeAnchor = null;
    coverageRangeHoverMonth = "";
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
    const body = await response.text();
    const payload = body
      ? (() => {
          try {
            return JSON.parse(body) as TPayload & { error?: string };
          } catch {
            return null;
          }
        })()
      : null;
    if (!response.ok) {
      const fallbackMessage = response.status >= 500 && !payload
        ? "De admin-backend is niet beschikbaar of start nog op."
        : `Verzoek mislukt (${response.status})`;
      throw new Error(
        payload && typeof payload === "object" && "error" in payload && payload.error
          ? String(payload.error)
          : body.trim() || fallbackMessage,
      );
    }
    if (payload === null) {
      throw new Error("Lege API-respons ontvangen.");
    }
    return payload;
  }

  function hasActiveRuns(items: IngestRunRecord[]): boolean {
    return items.some((run) => run.status === "queued" || run.status === "running");
  }

  function schedulePolling(): void {
    if (pollTimer !== null) return;
    pollTimer = window.setInterval(() => {
      void refreshPolledState();
    }, 5000);
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
    retryExecutionMode = "full";
    detailOpen = true;
    document.body.classList.add("body--locked");
  }

  async function loadSources(): Promise<void> {
    const payload = await fetchJson<AdminSourcesResponse>("/api/admin/sources");
    allSources = payload.sources ?? [];
    implementedSources = allSources.filter((source) => source.implemented);
    filterSources = implementedSources.filter((source) => !source.isAggregate);
  }

  async function loadRunSummary(): Promise<void> {
    const payload = await fetchJson<AdminRunSummaryResponse>("/api/admin/summary");
    runSummary = payload.summary;
  }

  async function loadExtractors(): Promise<void> {
    try {
      const payload = await fetchJson<{ workers: ExtractorWorker[] }>("/api/admin/extractors");
      extractorWorkers = payload.workers ?? [];
      extractorsLoaded = true;
    } catch {
      // Extraction workers are optional — ignore failures.
    }
  }

  async function loadCoverage(): Promise<void> {
    coverageBusy = true;
    try {
      const payload = await fetchJson<AdminCoverageResponse>(
        `/api/admin/coverage?months=${coverageMonthCount}`,
      );
      coverageRows = payload.rows ?? [];
      coverageMonths = payload.months ?? [];
      coverageMaxDocuments = payload.maxDocumentCount ?? 0;
      coverageLoaded = true;
    } finally {
      coverageBusy = false;
    }
  }

  async function refreshPolledState(): Promise<void> {
    await loadRunSummary();
    void loadExtractors();

    const params = new URLSearchParams();
    if (filterSource) params.set("source", filterSource);
    if (filterStatus) params.set("status", filterStatus);
    params.set("limit", `${Math.max(runs.length, RUNS_PAGE_SIZE)}`);

    const payload = await fetchJson<AdminRunsResponse>(`/api/admin/runs?${params.toString()}`);
    const fetchedRuns = payload.runs ?? [];
    runsHasMore = Boolean(payload.hasMore);
    runs = fetchedRuns;
    issuesByRun = await mergeRunIssues(runs);

    if (openRun) {
      const current = runs.find((run) => run.id === openRun?.id);
      if (current) {
        openRun = current;
        openIssues = issuesByRun.get(current.id) ?? [];
      } else {
        closeDetail();
      }
    }

    if (!hasActiveRuns(runs)) {
      stopPolling();
    }
  }

  async function mergeRunIssues(items: IngestRunRecord[]): Promise<Map<string, IngestRunIssueRecord[]>> {
    const nextIssues = new Map(issuesByRun);
    await Promise.all(
      items.map(async (run) => {
        if (run.issue_count <= 0) {
          nextIssues.set(run.id, []);
          return;
        }

        // Skip the per-run detail fetch if we already have all its issues
        // cached. Without this, every 5s poll refetches issues for every
        // run in the list — ~50+ parallel requests that peg the single-
        // threaded web server and stall user searches.
        const cached = nextIssues.get(run.id);
        if (cached && cached.length >= run.issue_count) {
          return;
        }

        const detail = await fetchJson<AdminRunDetailResponse>(`/api/admin/runs/${run.id}`);
        nextIssues.set(run.id, detail.issues ?? []);
      }),
    );
    return nextIssues;
  }

  async function loadRuns(mode: "replace" | "append" = "replace"): Promise<void> {
    if (mode === "append") {
      if (loadingOlderRuns || !runsHasMore) return;
      loadingOlderRuns = true;
    } else {
      runsBusy = true;
    }

    const params = new URLSearchParams();
    if (filterSource) params.set("source", filterSource);
    if (filterStatus) params.set("status", filterStatus);
    params.set("limit", `${RUNS_PAGE_SIZE}`);
    if (mode === "append") {
      params.set("offset", `${runs.length}`);
    }

    try {
      await loadRunSummary();
      const payload = await fetchJson<AdminRunsResponse>(`/api/admin/runs?${params.toString()}`);
      const fetchedRuns = payload.runs ?? [];
      runsHasMore = Boolean(payload.hasMore);
      runs = mode === "append" ? [...runs, ...fetchedRuns] : fetchedRuns;
      issuesByRun = await mergeRunIssues(runs);

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
    } finally {
      runsBusy = false;
      loadingOlderRuns = false;
    }
  }

  async function startImport(
    sourceRef: string,
    dateFrom: string,
    dateTo: string,
    options: {
      executionMode?: IngestExecutionMode;
      parentRunId?: string;
    } = {},
  ): Promise<IngestRunRecord[]> {
    const payload = await fetchJson<AdminRerunResponse>("/api/admin/rerun", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceRef,
        dateFrom,
        dateTo,
        executionMode: options.executionMode,
        parentRunId: options.parentRunId,
      } satisfies AdminRerunRequest),
    });

    const startedRuns = payload.runs ?? [];
    if (startedRuns.length === 0) {
      importStatus = "Er zijn geen imports gestart.";
      return [];
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
    return startedRuns;
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
    if (!isExecutionModeSelectable(importExecutionMode, importSourceRef)) {
      importStatus = executionModeAvailabilityNote(importExecutionMode, importSourceRef) ??
        "Deze uitvoermodus is niet beschikbaar.";
      return;
    }

    importBusy = true;
    importStatus = "Import gestart...";
    try {
      await startImport(importSourceRef, importDateFrom, importDateTo, {
        executionMode: importExecutionMode,
      });
    } catch (error) {
      importStatus = error instanceof Error ? error.message : "Import mislukt.";
    } finally {
      importBusy = false;
    }
  }

  async function importOpenRunAgain(): Promise<void> {
    if (!openRun) return;
    const source = allSources.find((item) => item.key === openRun?.source_key);
    const sourceRef = source?.sourceRef ?? openRun.source_key;
    if (!isExecutionModeSelectable(retryExecutionMode, sourceRef)) {
      importStatus = executionModeAvailabilityNote(retryExecutionMode, sourceRef) ??
        "Deze uitvoermodus is niet beschikbaar.";
      return;
    }
    detailImportBusy = true;
    importStatus = "Import gestart...";
    try {
      const startedRuns = await startImport(sourceRef, openRun.date_from, openRun.date_to, {
        executionMode: retryExecutionMode,
        parentRunId: openRun.id,
      });
      const startedRunId = startedRuns[0]?.id;
      const run = startedRunId
        ? runs.find((item) => item.id === startedRunId) ?? startedRuns[0]
        : null;
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
  $: if (!isExecutionModeSelectable(importExecutionMode, importSourceRef)) {
    importExecutionMode = "full";
  }

  onMount(async () => {
    importDateTo = formatDateInputValue(new Date());
    const lastWeek = new Date();
    lastWeek.setDate(lastWeek.getDate() - 7);
    importDateFrom = formatDateInputValue(lastWeek);

    try {
      bootLoading = true;
      bootError = "";
      await loadSources();
      await loadRuns();
      void loadExtractors();
    } catch (error) {
      bootError = error instanceof Error ? error.message : "Admin laden mislukt.";
    } finally {
      bootLoading = false;
    }
    document.addEventListener("keydown", handleEscape);
  });

  onDestroy(() => {
    stopPolling();
    document.removeEventListener("keydown", handleEscape);
  });
</script>

<div class="page-shell">
  <main class="content content--admin">
    {#if bootLoading}
      <section class="section">
        <div class="result-state">Loading...</div>
      </section>
    {:else if bootError}
      <section class="section">
        <div class="result-state">{bootError}</div>
      </section>
    {:else}
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
        <label class="search-field search-field--subtle search-field--compact admin-field">
          <input bind:value={importDateFrom} type="date" />
        </label>
        <label class="search-field search-field--subtle search-field--compact admin-field">
          <input bind:value={importDateTo} type="date" />
        </label>
        <label class="select-field select-field--compact admin-field admin-field--mode">
          <span class="sr-only">Importniveau</span>
          <select bind:value={importExecutionMode}>
            {#each executionModeOptions as option}
              <option
                value={option.value}
                disabled={!isExecutionModeSelectable(option.value, importSourceRef)}
              >
                {option.label}
              </option>
            {/each}
          </select>
        </label>
        <button type="submit" class="primary-button" disabled={importBusy}>Import uitvoeren</button>
      </form>
      <p class="admin-mode-help">
        <strong>{executionModeLabel(importExecutionMode)}</strong>:
        {executionModeDescription(importExecutionMode)}
      </p>
      {#if executionModeAvailabilityNote(importExecutionMode, importSourceRef)}
        <p class="admin-mode-note">{executionModeAvailabilityNote(importExecutionMode, importSourceRef)}</p>
      {/if}
      <div class="admin-mode-grid">
        {#each executionModeOptions as option}
          <article
            class="surface-card admin-mode-card"
            class:admin-mode-card--disabled={Boolean(executionModeAvailabilityNote(option.value, importSourceRef))}
          >
            <div class="admin-mode-card__header">
              <strong>{option.label}</strong>
              <span class={`pill pill--soft ${option.available ? "status-succeeded" : "status-queued"}`}>
                {executionModeAvailabilityNote(option.value, importSourceRef) ? "Nog niet" : "Beschikbaar"}
              </span>
            </div>
            <p>{option.description}</p>
            {#if executionModeAvailabilityNote(option.value, importSourceRef)}
              <p class="admin-mode-card__note">{executionModeAvailabilityNote(option.value, importSourceRef)}</p>
            {/if}
          </article>
        {/each}
      </div>
      <p class="admin-status">{importStatus}</p>
    </section>

    {#if runSummary}
      <section class="section">
        <div class="section__heading admin-section-heading">
          <h2>Importstatus</h2>
        </div>
        <div class="admin-summary-grid">
          <article class="surface-card admin-summary-card">
            <span class="admin-summary-card__label">In wachtrij</span>
            <strong class="admin-summary-card__value">{runSummary.queuedCount}</strong>
            <p>{compactRunLabel(runSummary.oldestQueuedRun)}</p>
          </article>
          <article class="surface-card admin-summary-card">
            <span class="admin-summary-card__label">Actief</span>
            <strong class="admin-summary-card__value">{runSummary.runningCount}</strong>
            <p>{compactRunLabel(runSummary.currentRun)}</p>
          </article>
          <article class="surface-card admin-summary-card">
            <span class="admin-summary-card__label">Geslaagd</span>
            <strong class="admin-summary-card__value">{runSummary.succeededCount}</strong>
            <p>Voltooide imports zonder issues die het eindresultaat blokkeerden.</p>
          </article>
          <article class="surface-card admin-summary-card">
            <span class="admin-summary-card__label">Met issues</span>
            <strong class="admin-summary-card__value">{runSummary.partialCount}</strong>
            <p>Imports die wel klaar zijn, maar met gedeeltelijke fouten.</p>
          </article>
          <article class="surface-card admin-summary-card">
            <span class="admin-summary-card__label">Mislukt</span>
            <strong class="admin-summary-card__value">{runSummary.failedCount}</strong>
            <p>Imports die handmatige inspectie of een gerichte retry nodig hebben.</p>
          </article>
        </div>
      </section>
    {/if}

    {#if extractorsLoaded && extractorWorkers.length > 0}
      <section class="section">
        <h2>Extractie-workers</h2>
        <div class="admin-extractors">
          {#each extractorWorkers as worker}
            <article class="surface-card admin-extractor-card" class:admin-extractor-card--down={worker.status !== "ok"}>
              <div class="admin-extractor-card__header">
                <span
                  class="admin-extractor-card__status"
                  class:admin-extractor-card__status--ok={worker.status === "ok"}
                  title={worker.status === "ok" ? "Online" : "Offline"}
                ></span>
                <span class="admin-extractor-card__url">{worker.url.replace("http://", "").replace(":8000", "")}</span>
              </div>
              {#if worker.status === "ok"}
                <div class="admin-extractor-card__stats">
                  <div class="admin-extractor-card__stat">
                    <span class="admin-extractor-card__stat-value">{worker.load_1m ?? "—"}</span>
                    <span class="admin-extractor-card__stat-label">CPU load</span>
                  </div>
                  <div class="admin-extractor-card__stat">
                    <span class="admin-extractor-card__stat-value">{worker.requests_total ?? 0}</span>
                    <span class="admin-extractor-card__stat-label">Verwerkt</span>
                  </div>
                  <div class="admin-extractor-card__stat">
                    <span class="admin-extractor-card__stat-value">{worker.uptime_seconds ? `${Math.round((worker.uptime_seconds) / 60)}m` : "—"}</span>
                    <span class="admin-extractor-card__stat-label">Uptime</span>
                  </div>
                </div>
              {/if}
            </article>
          {/each}
        </div>
      </section>
    {/if}

    <section class="section">
      <div class="section__heading">
        <button
          type="button"
          class="admin-coverage__toggle"
          aria-expanded={coverageOpen}
          on:click={toggleCoverage}
        >
          <h2>Dekking</h2>
          <span>{coverageOpen ? "Verberg" : "Toon"}</span>
        </button>
      </div>
      {#if coverageOpen}
        <div class="admin-coverage__controls">
          <label class="select-field select-field--compact">
            <span class="sr-only">Groepering voor dekkingsoverzicht</span>
            <select bind:value={coverageGrouping}>
              <option value="alphabetical">Alfabetisch</option>
              <option value="supplier">Per leverancier</option>
              <option value="type">Per bestuurslaag</option>
            </select>
          </label>
          <label class="select-field select-field--compact">
            <span class="sr-only">Periode voor dekkingsoverzicht</span>
            <select
              bind:value={coverageMonthCount}
              on:change={() => {
                coverageLoaded = false;
                if (coverageOpen) {
                  void loadCoverage();
                }
              }}
            >
              <option value="6">Laatste 6 maanden</option>
              <option value="12">Laatste 12 maanden</option>
              <option value="24">Laatste 24 maanden</option>
              <option value="36">Laatste 36 maanden</option>
              <option value="60">Laatste 60 maanden</option>
            </select>
          </label>
        </div>
      {/if}
      {#if coverageOpen && coverageLoaded && coverageRows.length > 0}
        <div class="admin-coverage">
          {#if coverageSelectedRange}
            <p class="admin-coverage__selection-note">
              Geselecteerd:
              <strong>{coverageSelectedSourceLabel()}</strong>
              · {monthLabel(coverageSelectedRange.startMonth)}
              t/m
              {monthLabel(coverageSelectedRange.endMonth)}
            </p>
          {/if}
          <div
            class="admin-coverage__months"
            style={`--coverage-column-count:${coverageMonths.length}`}
          >
            <div class="admin-coverage__months-spacer"></div>
            {#each coverageMonths as month}
              <div class="admin-coverage__month">{monthLabel(month)}</div>
            {/each}
          </div>
          <div class="admin-coverage__groups">
            {#each coverageGroups as group}
              <section class="admin-coverage__group">
                {#if coverageGrouping !== "alphabetical"}
                  <div class="admin-coverage__group-header">
                    <h3>{group.label}</h3>
                    <span>{group.rows.length} overheden</span>
                  </div>
                {/if}
                <div class="admin-coverage__rows">
                  {#each group.rows as row}
                    <CoverageHeatmapRow
                      {row}
                      months={coverageMonths}
                      maxDocuments={coverageMaxDocuments}
                      selectedRange={coverageSelectedRange?.sourceKey === row.sourceKey ? coverageSelectedRange : null}
                      previewRange={coveragePreviewRangeForSource(row.sourceKey)}
                      anchorMonth={coverageRangeAnchor?.sourceKey === row.sourceKey ? coverageRangeAnchor.month : ""}
                      on:selectsource={(event) => selectCoverageSource(event.detail.sourceKey)}
                      on:hovermonth={(event) => previewCoverageRange(event.detail.sourceKey, event.detail.month)}
                      on:leave={(event) => clearCoverageRangePreview(event.detail.sourceKey)}
                      on:selectmonth={(event) => selectCoverageCell(event.detail.sourceKey, event.detail.month)}
                    />
                  {/each}
                </div>
              </section>
            {/each}
          </div>
        </div>
      {:else if coverageOpen && coverageBusy}
        <div class="result-state">Dekkingsoverzicht laden...</div>
      {:else if coverageOpen && coverageLoaded}
        <div class="result-state">Nog geen gemeentelijke importgeschiedenis beschikbaar.</div>
      {/if}
    </section>

    <section class="section">
      <div class="section__heading admin-section-heading">
        <h2>Recente imports</h2>
      </div>
      <div class="admin-form admin-form--filters">
        <SourcePicker
          options={filterSources}
          bind:value={filterSource}
          placeholder="Alle bronnen"
          valueSelector={(source) => source.key}
          on:change={() => void loadRuns("replace")}
        />
        <label class="select-field select-field--compact">
          <span class="sr-only">Filter status</span>
          <select bind:value={filterStatus} on:change={() => void loadRuns("replace")}>
            <option value="">Alle statussen</option>
            <option value="queued">Wacht</option>
            <option value="running">Draait</option>
            <option value="succeeded">Geslaagd</option>
            <option value="partial">Gedeeltelijk</option>
            <option value="failed">Mislukt</option>
          </select>
        </label>
        <button type="button" class="ghost-button" on:click={() => void loadRuns("replace")}>Verversen</button>
      </div>
      <div class="admin-runs-table" aria-hidden="true">
        <div>Bron</div>
        <div>Status</div>
        <div>Start</div>
        <div>Eind</div>
        <div>Verg.</div>
        <div>Doc.</div>
        <div>Issues</div>
        <div>Cache</div>
        <div>Dl.</div>
        <div>Looptijd</div>
      </div>
      <div class="admin-runs">
        {#if runs.length === 0 && !runsBusy}
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
                  <strong>{run.source_key}</strong>
                </div>
                <div class="admin-run__status">
                  <span class={`pill pill--soft ${statusClassName(run.status)}`}>
                    {statusLabel(run.status)}
                  </span>
                </div>
                <div class="admin-run__metric admin-run__metric--date">
                  <strong>{formatDateCell(run.date_from)}</strong>
                </div>
                <div class="admin-run__metric admin-run__metric--date">
                  <strong>{formatDateCell(run.date_to)}</strong>
                </div>
                <div class="admin-run__metric"><strong>{run.meeting_count}</strong></div>
                <div class="admin-run__metric"><strong>{run.document_count}</strong></div>
                <div class="admin-run__metric"><strong>{run.issue_count}</strong></div>
                <div class="admin-run__metric"><strong>{run.cache_hits}</strong></div>
                <div class="admin-run__metric"><strong>{run.downloaded_count}</strong></div>
                <div class="admin-run__time">
                  <small title={run.started_at}>{formatRunDuration(run)}</small>
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
          {#if runsHasMore}
            <button
              type="button"
              class="ghost-button admin-runs__load-more"
              disabled={loadingOlderRuns}
              on:click={() => void loadRuns("append")}
            >
              {loadingOlderRuns ? "Oudere imports laden..." : "Laad oudere imports"}
            </button>
          {/if}
        {/if}
      </div>
    </section>
    {/if}
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
        <div class="detail-sheet__header-bar">
          <div class="detail-sheet__meta">
            <span class="pill">{openRun.source_key}</span>
            <span class={`pill pill--soft ${statusClassName(openRun.status)}`}>
              {statusLabel(openRun.status)}
            </span>
            <span class="detail-sheet__date">{periodLabel(openRun)}</span>
          </div>
          <div class="detail-sheet__header-actions">
            <a class="ghost-button" href={searchUrlForRun(openRun)}>
              Bekijk
            </a>
            <label class="select-field select-field--compact">
              <span class="sr-only">Retry-modus</span>
              <select bind:value={retryExecutionMode}>
                {#each executionModeOptions as option}
                  <option
                    value={option.value}
                    disabled={!isExecutionModeSelectable(
                      option.value,
                      allSources.find((item) => item.key === openRun.source_key)?.sourceRef ?? openRun.source_key,
                    )}
                  >
                    {option.label}
                  </option>
                {/each}
              </select>
            </label>
            <button
              class="primary-button"
              type="button"
              disabled={detailImportBusy}
              on:click={() => {
                void importOpenRunAgain();
              }}
            >
              Opnieuw
            </button>
            <button class="ghost-button" type="button" on:click={closeDetail}>
              Sluiten
            </button>
          </div>
        </div>
      </div>
      <div class="detail-sheet__body">
        <div class="admin-detail">
          <div class="admin-detail__grid">
            <div><strong>Import-ID</strong><p>{openRun.id}</p></div>
            <div><strong>Bron</strong><p>{openRun.source_key}</p></div>
            <div><strong>Gestart door</strong><p>{triggerLabel(openRun.trigger)}</p></div>
            <div><strong>Uitvoering</strong><p>{executionModeLabel(openRun.execution_mode)}</p></div>
            <div><strong>Status</strong><p>{statusLabel(openRun.status)}</p></div>
            <div><strong>Periode</strong><p>{periodLabel(openRun)}</p></div>
            <div><strong>Gestart</strong><p>{openRun.started_at}</p></div>
            <div><strong>Looptijd</strong><p>{formatRunDuration(openRun)}</p></div>
            <div><strong>Projectie</strong><p>{openRun.projection_version ?? "onbekend"}</p></div>
            <div><strong>Afleiding</strong><p>{openRun.derivation_version ?? "onbekend"}</p></div>
            <div><strong>Vergaderingen</strong><p>{openRun.meeting_count}</p></div>
            <div><strong>Documenten</strong><p>{openRun.document_count}</p></div>
            <div><strong>Documentfouten</strong><p>{failedDocumentCount(openRun)}</p></div>
            <div><strong>Cache hits</strong><p>{openRun.cache_hits}</p></div>
            <div><strong>Downloads</strong><p>{openRun.downloaded_count}</p></div>
            <div><strong>Issues</strong><p>{openRun.issue_count}</p></div>
          </div>

          <div class="admin-detail__issues">
            <div class="admin-mode-detail">
              <strong>{executionModeLabel(retryExecutionMode)}</strong>
              <p>{executionModeDescription(retryExecutionMode)}</p>
              {#if executionModeAvailabilityNote(
                retryExecutionMode,
                allSources.find((item) => item.key === openRun.source_key)?.sourceRef ?? openRun.source_key,
              )}
                <p class="admin-mode-note">
                  {executionModeAvailabilityNote(
                    retryExecutionMode,
                    allSources.find((item) => item.key === openRun.source_key)?.sourceRef ?? openRun.source_key,
                  )}
                </p>
              {/if}
            </div>
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
