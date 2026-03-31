/// <reference lib="dom" />

import type {
  AdminRunDetailResponse,
  AdminRerunRequest,
  AdminRerunResponse,
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

function searchUrlForRun(run: IngestRunRecord): string {
  const params = new URLSearchParams({
    organization: run.source_key,
    sort: "date_desc",
  });

  return `/?${params.toString()}`;
}

function runSummary(run: IngestRunRecord): string {
  return `${run.meeting_count} vergaderingen · ${run.document_count} documenten · ${run.cache_hits} cache hits · ${run.downloaded_count} downloads`;
}

function previewIssue(
  run: IngestRunRecord,
  issuesByRun: Map<string, IngestRunIssueRecord[]>,
): string {
  const issues = issuesByRun.get(run.id) ?? [];
  if (issues.length === 0) {
    return "";
  }

  const first = issues[0];
  return `${first.step}${first.entity_id ? ` (${first.entity_id})` : ""}: ${first.message}`;
}

function renderRuns(
  container: HTMLElement,
  runs: IngestRunRecord[],
  issuesByRun: Map<string, IngestRunIssueRecord[]>,
  onSelect: (runId: string) => void,
): void {
  container.textContent = "";

  if (runs.length === 0) {
    container.textContent = "Nog geen runs gevonden.";
    return;
  }

  runs.forEach((run) => {
    const button = document.createElement("button");
    button.className = "admin-run";
    button.type = "button";
    const issuePreview = previewIssue(run, issuesByRun);
    button.innerHTML = `
      <div class="admin-run__header">
        <div class="admin-run__meta">
          <span class="pill">${run.source_key}</span>
          <span class="pill pill--soft ${statusClassName(run.status)}">${statusLabel(run.status)}</span>
          <span class="admin-run__date">${periodLabel(run)}</span>
        </div>
      </div>
      <p>${runSummary(run)}</p>
      <small>${run.started_at}</small>
      ${
        issuePreview
          ? `<div class="admin-run__issue"><strong>${run.issue_count} issue${run.issue_count === 1 ? "" : "s"}</strong><span>${issuePreview}</span></div>`
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
      <div><strong>Run ID</strong><p>${detail.run.id}</p></div>
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

async function bootstrapAdmin(): Promise<void> {
  const runsList = requiredElement<HTMLElement>("#runs-list");
  const filterSource = requiredElement<HTMLSelectElement>("#filter-source");
  const filterStatus = requiredElement<HTMLSelectElement>("#filter-status");
  const refreshRuns = requiredElement<HTMLButtonElement>("#refresh-runs");
  const rerunForm = requiredElement<HTMLFormElement>("#rerun-form");
  const rerunSource = requiredElement<HTMLSelectElement>("#rerun-source");
  const rerunDateFrom = requiredElement<HTMLInputElement>("#rerun-date-from");
  const rerunDateTo = requiredElement<HTMLInputElement>("#rerun-date-to");
  const rerunStatus = requiredElement<HTMLElement>("#rerun-status");
  const detailOverlay = requiredElement<HTMLElement>("#admin-detail-overlay");
  const detailSource = requiredElement<HTMLElement>('[data-role="admin-detail-source"]');
  const detailStatus = requiredElement<HTMLElement>('[data-role="admin-detail-status"]');
  const detailPeriod = requiredElement<HTMLElement>('[data-role="admin-detail-period"]');
  const detailBody = requiredElement<HTMLElement>('[data-role="admin-detail-body"]');
  const detailRerun = requiredElement<HTMLButtonElement>('[data-role="admin-detail-rerun"]');
  const detailViewResults = requiredElement<HTMLAnchorElement>(
    '[data-role="admin-detail-view-results"]',
  );
  const closeButtons = document.querySelectorAll<HTMLElement>('[data-role="close-admin-detail"]');
  let openRun: IngestRunRecord | null = null;
  let currentRuns: IngestRunRecord[] = [];
  let pollTimer: number | null = null;

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

  async function loadSources(): Promise<void> {
    const payload = await fetchJson<AdminSourcesResponse>("/api/admin/sources");
    for (const source of payload.sources) {
      const option = document.createElement("option");
      option.value = source.key;
      option.textContent = source.label;
      rerunSource.appendChild(option.cloneNode(true));
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

  rerunForm.addEventListener("submit", async (event: SubmitEvent) => {
    event.preventDefault();
    if (!rerunSource.value.trim()) {
      rerunStatus.textContent = "Kies eerst een bron.";
      return;
    }
    if (!rerunDateFrom.value.trim() || !rerunDateTo.value.trim()) {
      rerunStatus.textContent = "Vul zowel een start- als einddatum in.";
      return;
    }
    if (rerunDateFrom.value > rerunDateTo.value) {
      rerunStatus.textContent = "De startdatum moet op of voor de einddatum liggen.";
      return;
    }
    rerunStatus.textContent = "Rerun gestart...";

    try {
      const payload = await fetchJson<AdminRerunResponse>("/api/admin/rerun", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sourceKey: rerunSource.value,
          dateFrom: rerunDateFrom.value,
          dateTo: rerunDateTo.value,
        } satisfies AdminRerunRequest),
      });
      rerunStatus.textContent = `Run ${payload.run.id} gestart.`;
      currentRuns = [payload.run, ...currentRuns];
      renderRuns(runsList, currentRuns, new Map(), async (runId) => {
        const detail = await fetchJson<AdminRunDetailResponse>(`/api/admin/runs/${runId}`);
        openDetail(detail);
      });
      schedulePolling();
      await loadRuns();
    } catch (error) {
      rerunStatus.textContent = error instanceof Error ? error.message : "Rerun mislukt.";
    }
  });

  detailRerun.addEventListener("click", async () => {
    if (!openRun) {
      return;
    }

    detailRerun.disabled = true;
    rerunStatus.textContent = "Rerun gestart...";

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

      rerunStatus.textContent = `Run ${payload.run.id} gestart.`;
      currentRuns = [payload.run, ...currentRuns];
      renderRuns(runsList, currentRuns, new Map(), async (runId) => {
        const detail = await fetchJson<AdminRunDetailResponse>(`/api/admin/runs/${runId}`);
        openDetail(detail);
      });
      openDetail({ run: payload.run, issues: [] });
      schedulePolling();
      await loadRuns();
    } catch (error) {
      rerunStatus.textContent = error instanceof Error ? error.message : "Rerun mislukt.";
    } finally {
      detailRerun.disabled = false;
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
