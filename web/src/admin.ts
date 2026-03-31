/// <reference lib="dom" />

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

function periodLabel(run: IngestRunRecord): string {
  return `${run.date_from} t/m ${run.date_to}`;
}

const relativeTimeFormatter = new Intl.RelativeTimeFormat("nl-NL", {
  numeric: "auto",
});

function formatRelativeTime(dateValue?: string): string {
  if (!dateValue) {
    return "Onbekend moment";
  }

  const target = new Date(dateValue);
  if (Number.isNaN(target.getTime())) {
    return dateValue;
  }

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
    sort: "date_desc",
  });

  return `/?${params.toString()}`;
}

function summarizeIssueTypes(
  run: IngestRunRecord,
  issuesByRun: Map<string, IngestRunIssueRecord[]>,
): Array<{ label: string; count: number }> {
  const issues = issuesByRun.get(run.id) ?? [];
  if (issues.length === 0) {
    return [];
  }

  const counts = new Map<string, number>();
  for (const issue of issues) {
    counts.set(issue.step, (counts.get(issue.step) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "nl"));
}

function renderRuns(
  container: HTMLElement,
  runs: IngestRunRecord[],
  issuesByRun: Map<string, IngestRunIssueRecord[]>,
  onSelect: (runId: string) => void,
): void {
  container.textContent = "";

  if (runs.length === 0) {
    container.textContent = "Nog geen imports gevonden.";
    return;
  }

  runs.forEach((run) => {
    const button = document.createElement("button");
    button.className = "surface-card admin-run";
    button.type = "button";
    const issueSummary = summarizeIssueTypes(run, issuesByRun);
    button.innerHTML = `
      <div class="admin-run__row">
        <div class="admin-run__primary">
          <div class="admin-run__meta">
            <span class="pill">${run.source_key}</span>
            <span class="pill pill--soft ${statusClassName(run.status)}">${statusLabel(run.status)}</span>
            <span class="admin-run__date">${periodLabel(run)}</span>
          </div>
        </div>
        <div class="admin-run__metric"><strong>${run.meeting_count}</strong></div>
        <div class="admin-run__metric"><strong>${run.document_count}</strong></div>
        <div class="admin-run__metric"><strong>${run.cache_hits}</strong></div>
        <div class="admin-run__metric"><strong>${run.downloaded_count}</strong></div>
        <div class="admin-run__time">
          <small title="${run.started_at}">${formatRelativeTime(run.started_at)}</small>
        </div>
      </div>
      ${
        issueSummary.length > 0
          ? `<div class="admin-run__issue"><strong>${run.issue_count} issue${run.issue_count === 1 ? "" : "s"}</strong><div class="admin-run__issue-list">${issueSummary
              .map(
                (issue) =>
                  `<span class="admin-run__issue-chip"><span class="admin-run__issue-count">${issue.count}×</span> ${issue.label}</span>`,
              )
              .join("")}</div></div>`
          : ""
      }
    `;
    button.addEventListener("click", () => onSelect(run.id));
    container.appendChild(button);
  });
}

function renderRunDetail(container: HTMLElement, detail: AdminRunDetailResponse): void {
  const issues = detail.issues ?? [];
  container.innerHTML = `
    <div class="admin-detail__grid">
      <div><strong>Import-ID</strong><p>${detail.run.id}</p></div>
      <div><strong>Bron</strong><p>${detail.run.source_key}</p></div>
      <div><strong>Status</strong><p>${statusLabel(detail.run.status)}</p></div>
      <div><strong>Periode</strong><p>${periodLabel(detail.run)}</p></div>
      <div><strong>Gestart</strong><p>${detail.run.started_at}</p></div>
      <div><strong>Vergaderingen</strong><p>${detail.run.meeting_count}</p></div>
      <div><strong>Documenten</strong><p>${detail.run.document_count}</p></div>
      <div><strong>Cache hits</strong><p>${detail.run.cache_hits}</p></div>
      <div><strong>Downloads</strong><p>${detail.run.downloaded_count}</p></div>
      <div><strong>Issues</strong><p>${detail.run.issue_count}</p></div>
    </div>
    <div class="admin-detail__issues">
      <h3>Issues</h3>
      ${
        issues.length > 0
          ? `<ul>${issues
              .map(
                (issue) =>
                  `<li><strong>${issue.step}</strong> ${issue.entity_id ? `(${issue.entity_id})` : ""}: ${issue.message}</li>`,
              )
              .join("")}</ul>`
          : "<p>Geen issues geregistreerd.</p>"
      }
    </div>
  `;
}

async function fetchJson<TPayload>(url: string, options?: RequestInit): Promise<TPayload> {
  const response = await fetch(url, options);
  const payload = (await response.json()) as TPayload & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error ?? "Verzoek mislukt");
  }
  return payload;
}

function requiredElement<TElement extends Element>(selector: string): TElement {
  const element = document.querySelector<TElement>(selector);
  if (!element) {
    throw new Error(`Element niet gevonden: ${selector}`);
  }
  return element;
}

function formatDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function bootstrapAdmin(): Promise<void> {
  const runsList = requiredElement<HTMLElement>("#runs-list");
  const filterSource = requiredElement<HTMLSelectElement>("#filter-source");
  const filterStatus = requiredElement<HTMLSelectElement>("#filter-status");
  const refreshRuns = requiredElement<HTMLButtonElement>("#refresh-runs");
  const importForm = requiredElement<HTMLFormElement>("#import-form");
  const importSourceQuery = requiredElement<HTMLInputElement>("#import-source-query");
  const importSourceRef = requiredElement<HTMLInputElement>("#import-source-ref");
  const importSourceResults = requiredElement<HTMLElement>("#import-source-results");
  const importDateFrom = requiredElement<HTMLInputElement>("#import-date-from");
  const importDateTo = requiredElement<HTMLInputElement>("#import-date-to");
  const importStatus = requiredElement<HTMLElement>("#import-status");
  const detailOverlay = requiredElement<HTMLElement>("#admin-detail-overlay");
  const detailSource = requiredElement<HTMLElement>('[data-role="admin-detail-source"]');
  const detailStatus = requiredElement<HTMLElement>('[data-role="admin-detail-status"]');
  const detailPeriod = requiredElement<HTMLElement>('[data-role="admin-detail-period"]');
  const detailBody = requiredElement<HTMLElement>('[data-role="admin-detail-body"]');
  const detailImport = requiredElement<HTMLButtonElement>('[data-role="admin-detail-import"]');
  const detailViewResults = requiredElement<HTMLAnchorElement>(
    '[data-role="admin-detail-view-results"]',
  );
  const closeButtons = document.querySelectorAll<HTMLElement>('[data-role="close-admin-detail"]');
  let openRun: IngestRunRecord | null = null;
  let currentRuns: IngestRunRecord[] = [];
  let allAdminSources: AdminSourceOption[] = [];
  const sourceByLabel = new Map<string, AdminSourceOption>();
  let pollTimer: number | null = null;

  importDateTo.value = formatDateInputValue(new Date());
  const lastWeek = new Date();
  lastWeek.setDate(lastWeek.getDate() - 7);
  importDateFrom.value = formatDateInputValue(lastWeek);

  function hasActiveRuns(runs: IngestRunRecord[]): boolean {
    return runs.some((run) => run.status === "running");
  }

  function schedulePolling(): void {
    if (pollTimer !== null) {
      return;
    }

    pollTimer = window.setInterval(() => {
      void loadRuns();
    }, 1500);
  }

  function stopPolling(): void {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function closeDetail(): void {
    detailOverlay.hidden = true;
    document.body.classList.remove("body--locked");
    openRun = null;
  }

  function openDetail(detail: AdminRunDetailResponse): void {
    openRun = detail.run;
    detailSource.textContent = detail.run.source_key;
    detailStatus.className = `pill pill--soft ${statusClassName(detail.run.status)}`;
    detailStatus.textContent = statusLabel(detail.run.status);
    detailPeriod.textContent = periodLabel(detail.run);
    detailViewResults.href = searchUrlForRun(detail.run);
    renderRunDetail(detailBody, detail);
    detailOverlay.hidden = false;
    document.body.classList.add("body--locked");
  }

  closeButtons.forEach((button: HTMLElement) => {
    button.addEventListener("click", closeDetail);
  });

  document.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape" && !detailOverlay.hidden) {
      closeDetail();
    }
  });

  function clearImportSourceSelection(): void {
    importSourceRef.value = "";
  }

  function selectImportSource(source: AdminSourceOption): void {
    importSourceQuery.value = source.label;
    importSourceRef.value = source.sourceRef;
    importSourceResults.hidden = true;
  }

  function renderImportSourceOptions(query = ""): void {
    const normalizedQuery = query.trim().toLowerCase();
    importSourceResults.replaceChildren();

    if (!normalizedQuery) {
      importSourceResults.hidden = true;
      return;
    }

    const filteredSources = allAdminSources.filter((source) => {
      if (!normalizedQuery) {
        return true;
      }

      return [source.label, source.key, source.sourceRef, source.supplier, source.organizationType]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
    });

    if (filteredSources.length === 0) {
      importSourceResults.hidden = false;
      const emptyState = document.createElement("div");
      emptyState.className = "admin-source-results__empty";
      emptyState.textContent = "Geen bronnen gevonden.";
      importSourceResults.appendChild(emptyState);
      return;
    }

    for (const source of filteredSources) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "admin-source-option";
      button.disabled = !source.implemented;
      button.innerHTML = `
        <strong>${source.label}</strong>
        <span>${source.supplier} · ${source.organizationType}${source.implemented ? "" : " · nog niet ondersteund"}</span>
      `;
      button.addEventListener("click", () => {
        if (!source.implemented) {
          return;
        }
        selectImportSource(source);
      });
      importSourceResults.appendChild(button);
    }

    importSourceResults.hidden = false;
  }

  async function loadSources(): Promise<void> {
    const payload = await fetchJson<AdminSourcesResponse>("/api/admin/sources");
    allAdminSources = payload.sources ?? [];
    sourceByLabel.clear();
    for (const source of allAdminSources) {
      sourceByLabel.set(source.label, source);
    }
    renderImportSourceOptions();
    for (const source of allAdminSources.filter((item) => item.implemented)) {
      const option = document.createElement("option");
      option.value = source.key;
      option.textContent = source.label;
      filterSource.appendChild(option);
    }
  }

  async function loadRuns(): Promise<void> {
    const params = new URLSearchParams();
    if (filterSource.value) params.set("source", filterSource.value);
    if (filterStatus.value) params.set("status", filterStatus.value);

    const payload = await fetchJson<AdminRunsResponse>(`/api/admin/runs?${params.toString()}`);
    const runs = payload.runs ?? [];
    currentRuns = runs;
    const issuesByRun = new Map<string, IngestRunIssueRecord[]>();

    await Promise.all(
      runs.map(async (run) => {
        if (run.issue_count <= 0) {
          issuesByRun.set(run.id, []);
          return;
        }
        const detail = await fetchJson<AdminRunDetailResponse>(`/api/admin/runs/${run.id}`);
        issuesByRun.set(run.id, detail.issues ?? []);
      }),
    );

    renderRuns(runsList, runs, issuesByRun, async (runId) => {
      const existing = runs.find((run) => run.id === runId);
      if (!existing) {
        return;
      }

      const detail: AdminRunDetailResponse = issuesByRun.has(runId)
        ? { run: existing, issues: issuesByRun.get(runId) ?? [] }
        : await fetchJson<AdminRunDetailResponse>(`/api/admin/runs/${runId}`);
      openDetail(detail);
    });

    if (hasActiveRuns(runs)) {
      schedulePolling();
    } else {
      stopPolling();
    }
  }

  refreshRuns.addEventListener("click", () => {
    void loadRuns();
  });
  filterSource.addEventListener("change", () => {
    void loadRuns();
  });
  filterStatus.addEventListener("change", () => {
    void loadRuns();
  });
  importSourceQuery.addEventListener("input", () => {
    const selectedSource = sourceByLabel.get(importSourceQuery.value.trim());
    if (selectedSource?.implemented) {
      importSourceRef.value = selectedSource.sourceRef;
      importSourceResults.hidden = true;
      return;
    }

    clearImportSourceSelection();
    renderImportSourceOptions(importSourceQuery.value);
  });
  importSourceQuery.addEventListener("focus", () => {
    renderImportSourceOptions(importSourceQuery.value);
  });
  importSourceQuery.addEventListener("blur", () => {
    window.setTimeout(() => {
      importSourceResults.hidden = true;
    }, 120);
  });

  importForm.addEventListener("submit", async (event: SubmitEvent) => {
    event.preventDefault();
    const selectedSource =
      sourceByLabel.get(importSourceQuery.value.trim()) ??
      allAdminSources.find((source) => source.sourceRef === importSourceRef.value);
    if (!selectedSource) {
      importStatus.textContent = "Kies eerst een bron uit de suggesties.";
      return;
    }
    if (!selectedSource.implemented) {
      importStatus.textContent = "Deze bron is nog niet ondersteund in Woozi.";
      return;
    }
    if (!importDateFrom.value.trim() || !importDateTo.value.trim()) {
      importStatus.textContent = "Vul zowel een start- als einddatum in.";
      return;
    }
    if (importDateFrom.value > importDateTo.value) {
      importStatus.textContent = "De startdatum moet op of voor de einddatum liggen.";
      return;
    }
    importStatus.textContent = "Import gestart...";

    try {
      const payload = await fetchJson<AdminRerunResponse>("/api/admin/rerun", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sourceRef: selectedSource.sourceRef,
          dateFrom: importDateFrom.value,
          dateTo: importDateTo.value,
        } satisfies AdminRerunRequest),
      });
      importStatus.textContent = `Import ${payload.run.id} gestart.`;
      currentRuns = [payload.run, ...currentRuns];
      renderRuns(runsList, currentRuns, new Map(), async (runId) => {
        const detail = await fetchJson<AdminRunDetailResponse>(`/api/admin/runs/${runId}`);
        openDetail(detail);
      });
      schedulePolling();
      await loadRuns();
    } catch (error) {
      importStatus.textContent = error instanceof Error ? error.message : "Import mislukt.";
    }
  });

  detailImport.addEventListener("click", async () => {
    if (!openRun) {
      return;
    }

    detailImport.disabled = true;
    importStatus.textContent = "Import gestart...";

    try {
      const payload = await fetchJson<AdminRerunResponse>("/api/admin/rerun", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sourceKey: openRun.source_key,
          dateFrom: openRun.date_from,
          dateTo: openRun.date_to,
        } satisfies AdminRerunRequest),
      });

      importStatus.textContent = `Import ${payload.run.id} gestart.`;
      currentRuns = [payload.run, ...currentRuns];
      renderRuns(runsList, currentRuns, new Map(), async (runId) => {
        const detail = await fetchJson<AdminRunDetailResponse>(`/api/admin/runs/${runId}`);
        openDetail(detail);
      });
      openDetail({ run: payload.run, issues: [] });
      schedulePolling();
      await loadRuns();
    } catch (error) {
      importStatus.textContent = error instanceof Error ? error.message : "Import mislukt.";
    } finally {
      detailImport.disabled = false;
    }
  });

  await loadSources();
  await loadRuns();
}

void bootstrapAdmin().catch((error) => {
  const runsList = document.querySelector<HTMLElement>("#runs-list");
  if (runsList) {
    runsList.textContent = error instanceof Error ? error.message : "Admin laden mislukt.";
  }
});
