function statusLabel(status) {
  const labels = {
    running: "Draait",
    succeeded: "Geslaagd",
    partial: "Gedeeltelijk",
    failed: "Mislukt",
  };
  return labels[status] ?? status;
}

function titleForRun(run) {
  return `${run.source_key} · ${run.date_from} t/m ${run.date_to}`;
}

function runSummary(run) {
  return `${run.meeting_count} vergaderingen · ${run.document_count} documenten · ${run.cache_hits} cache hits · ${run.downloaded_count} downloads`;
}

function previewIssue(run, issuesByRun) {
  const issues = issuesByRun.get(run.id) ?? [];
  if (issues.length === 0) {
    return "";
  }

  const first = issues[0];
  return `${first.step}${first.entity_id ? ` (${first.entity_id})` : ""}: ${first.message}`;
}

function renderRuns(container, runs, issuesByRun, onSelect) {
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
        <strong>${titleForRun(run)}</strong>
        <span class="pill pill--soft">${statusLabel(run.status)}</span>
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

function renderRunDetail(container, detail) {
  const issues = detail.issues ?? [];
  container.innerHTML = `
    <div class="admin-detail__grid">
      <div><strong>Bron</strong><p>${detail.run.source_key}</p></div>
      <div><strong>Status</strong><p>${statusLabel(detail.run.status)}</p></div>
      <div><strong>Periode</strong><p>${detail.run.date_from} t/m ${detail.run.date_to}</p></div>
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

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error ?? "Verzoek mislukt");
  }
  return payload;
}

async function bootstrapAdmin() {
  const runsList = document.querySelector("#runs-list");
  const filterSource = document.querySelector("#filter-source");
  const filterStatus = document.querySelector("#filter-status");
  const refreshRuns = document.querySelector("#refresh-runs");
  const rerunForm = document.querySelector("#rerun-form");
  const rerunSource = document.querySelector("#rerun-source");
  const rerunDateFrom = document.querySelector("#rerun-date-from");
  const rerunDateTo = document.querySelector("#rerun-date-to");
  const rerunStatus = document.querySelector("#rerun-status");
  const detailOverlay = document.querySelector("#admin-detail-overlay");
  const detailSource = document.querySelector('[data-role="admin-detail-source"]');
  const detailStatus = document.querySelector('[data-role="admin-detail-status"]');
  const detailStarted = document.querySelector('[data-role="admin-detail-started"]');
  const detailTitle = document.querySelector('[data-role="admin-detail-title"]');
  const detailBody = document.querySelector('[data-role="admin-detail-body"]');
  const closeButtons = document.querySelectorAll('[data-role="close-admin-detail"]');

  function closeDetail() {
    detailOverlay.hidden = true;
    document.body.classList.remove("body--locked");
  }

  function openDetail(detail) {
    detailSource.textContent = detail.run.source_key;
    detailStatus.textContent = statusLabel(detail.run.status);
    detailStarted.textContent = detail.run.started_at;
    detailTitle.textContent = titleForRun(detail.run);
    renderRunDetail(detailBody, detail);
    detailOverlay.hidden = false;
    document.body.classList.add("body--locked");
  }

  closeButtons.forEach((button) => {
    button.addEventListener("click", closeDetail);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !detailOverlay.hidden) {
      closeDetail();
    }
  });

  async function loadSources() {
    const payload = await fetchJson("/api/admin/sources");
    for (const source of payload.sources) {
      const option = document.createElement("option");
      option.value = source.key;
      option.textContent = source.label;
      rerunSource.appendChild(option.cloneNode(true));
      filterSource.appendChild(option);
    }
  }

  async function loadRuns() {
    const params = new URLSearchParams();
    if (filterSource.value) params.set("source", filterSource.value);
    if (filterStatus.value) params.set("status", filterStatus.value);

    const payload = await fetchJson(`/api/admin/runs?${params.toString()}`);
    const runs = payload.runs ?? [];
    const issuesByRun = new Map();

    await Promise.all(
      runs.map(async (run) => {
        if (run.issue_count <= 0) {
          issuesByRun.set(run.id, []);
          return;
        }
        const detail = await fetchJson(`/api/admin/runs/${run.id}`);
        issuesByRun.set(run.id, detail.issues ?? []);
      }),
    );

    renderRuns(runsList, runs, issuesByRun, async (runId) => {
      const detail = issuesByRun.has(runId)
        ? { run: runs.find((run) => run.id === runId), issues: issuesByRun.get(runId) }
        : await fetchJson(`/api/admin/runs/${runId}`);
      openDetail(detail);
    });
  }

  refreshRuns.addEventListener("click", loadRuns);
  filterSource.addEventListener("change", loadRuns);
  filterStatus.addEventListener("change", loadRuns);

  rerunForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    rerunStatus.textContent = "Rerun gestart...";

    try {
      const payload = await fetchJson("/api/admin/rerun", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sourceKey: rerunSource.value,
          dateFrom: rerunDateFrom.value,
          dateTo: rerunDateTo.value,
        }),
      });
      rerunStatus.textContent = `Run ${payload.run.id} afgerond met status ${statusLabel(payload.run.status)}.`;
      await loadRuns();
    } catch (error) {
      rerunStatus.textContent = error instanceof Error ? error.message : "Rerun mislukt.";
    }
  });

  await loadSources();
  await loadRuns();
}

bootstrapAdmin().catch((error) => {
  const runsList = document.querySelector("#runs-list");
  if (runsList) {
    runsList.textContent = error instanceof Error ? error.message : "Admin laden mislukt.";
  }
});
