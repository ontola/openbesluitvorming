// Isolate the ops store singleton in a temp database for this file.
Deno.env.set("WOOZI_KV_PATH", await Deno.makeTempFile({ suffix: ".sqlite3" }));

import { DatabaseSync } from "node:sqlite";
import {
  claimQueuedRun,
  createRun,
  getRunDetails,
  reconcileInterruptedRuns,
} from "../src/ops/store.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    );
  }
}

/** Reconcile skips claims fresher than its age margin (sibling-worker race
 * guard), so tests that want a run reconciled must age its claim first. */
function backdateRunStart(runId: string, minutes = 10): void {
  const db = new DatabaseSync(Deno.env.get("WOOZI_KV_PATH")!);
  try {
    db.prepare(`UPDATE ingest_run SET started_at = ?, claimed_at = ? WHERE id = ?`).run(
      new Date(Date.now() - minutes * 60_000).toISOString(),
      new Date(Date.now() - minutes * 60_000).toISOString(),
      runId,
    );
  } finally {
    db.close();
  }
}

/** A run that sat in the queue for a while: enqueued long ago, claimed now
 * (or not yet). */
function backdateEnqueue(runId: string, minutes = 300): void {
  const db = new DatabaseSync(Deno.env.get("WOOZI_KV_PATH")!);
  try {
    db.prepare(`UPDATE ingest_run SET started_at = ? WHERE id = ?`).run(
      new Date(Date.now() - minutes * 60_000).toISOString(),
      runId,
    );
  } finally {
    db.close();
  }
}

async function createRunningRun(sourceKey: string): Promise<string> {
  const run = await createRun({
    source_key: sourceKey,
    supplier: "notubiz",
    date_from: "2024-01-01",
    date_to: "2024-12-31",
    trigger: "scheduled",
    execution_mode: "full",
    parent_run_id: undefined,
    projection_version: "test",
    derivation_version: "test",
    status: "queued",
  });
  const claimed = await claimQueuedRun(run.id);
  assert(claimed, "run can be claimed");
  backdateRunStart(run.id);
  return run.id;
}

Deno.test("interrupted runs are requeued instead of failed, up to the cap", async () => {
  const runId = await createRunningRun("soest");

  // First restart: requeued.
  let reconciled = await reconcileInterruptedRuns();
  let target = reconciled.find((run) => run.id === runId);
  assert(target, "interrupted run is reconciled");
  assertEquals(target.status, "queued", "first interruption requeues the run");

  // Restarts two through five: requeued again.
  for (let interruption = 2; interruption <= 5; interruption += 1) {
    assert(
      await claimQueuedRun(runId),
      `requeued run can be claimed (interruption ${interruption})`,
    );
    backdateRunStart(runId);
    reconciled = await reconcileInterruptedRuns();
    target = reconciled.find((run) => run.id === runId);
    assertEquals(target?.status, "queued", `interruption ${interruption} still requeues`);
  }

  // Sixth restart: the cap is reached; the run fails for good.
  assert(await claimQueuedRun(runId), "run can be claimed a final time");
  backdateRunStart(runId);
  reconciled = await reconcileInterruptedRuns();
  target = reconciled.find((run) => run.id === runId);
  assertEquals(target?.status, "failed", "interruption past the cap fails the run");
  assert(
    target?.error_message?.includes("Process terminated"),
    "failed run keeps the reconcile error message",
  );

  const details = await getRunDetails(runId);
  const issues = details?.issues ?? [];
  assertEquals(
    issues.filter((issue) => issue.severity === "warning").length,
    5,
    "each requeue leaves a warning issue",
  );
  assertEquals(
    issues.filter((issue) => issue.severity === "error").length,
    1,
    "the final failure leaves an error issue",
  );
});

Deno.test("reconcile does not touch queued or finished runs", async () => {
  const untouched = await createRun({
    source_key: "haarlem",
    supplier: "notubiz",
    date_from: "2024-01-01",
    date_to: "2024-12-31",
    trigger: "scheduled",
    execution_mode: "full",
    parent_run_id: undefined,
    projection_version: "test",
    derivation_version: "test",
    status: "queued",
  });

  const reconciled = await reconcileInterruptedRuns();
  assert(!reconciled.some((run) => run.id === untouched.id), "queued runs are not reconciled");

  const details = await getRunDetails(untouched.id);
  assertEquals(details?.run.status, "queued", "queued run keeps its status");
});

Deno.test("reconcile leaves freshly claimed runs to their owning worker", async () => {
  const run = await createRun({
    source_key: "soest",
    supplier: "notubiz",
    date_from: "2024-01-01",
    date_to: "2024-12-31",
    trigger: "scheduled",
    execution_mode: "full",
    parent_run_id: undefined,
    projection_version: "test",
    derivation_version: "test",
    status: "queued",
  });
  assert(await claimQueuedRun(run.id), "run can be claimed");
  // No backdate: this claim is seconds old, as if a sibling worker just took
  // it while this process was booting.
  const reconciled = await reconcileInterruptedRuns();
  assert(
    !reconciled.some((item) => item.id === run.id),
    "a fresh claim must not be requeued by a booting sibling",
  );
});

Deno.test("a run that queued for hours and was just claimed is not requeued", async () => {
  // 2026-09-05: a backfill of 1,172 chunks was enqueued at 07:18 and the
  // workers restarted at 12:22. Judged by started_at every fresh claim was
  // five hours old, so each booting worker requeued its siblings' claims and
  // took them itself; eight runs ran in triplicate.
  const run = await createRun({
    source_key: "almelo",
    supplier: "ibabs",
    date_from: "2025-09-05",
    date_to: "2026-03-05",
    trigger: "scheduled",
    execution_mode: "full",
    parent_run_id: undefined,
    projection_version: "test",
    derivation_version: "test",
    status: "queued",
  });
  backdateEnqueue(run.id);
  assert(await claimQueuedRun(run.id), "run can be claimed");

  const reconciled = await reconcileInterruptedRuns();
  assert(
    !reconciled.some((item) => item.id === run.id),
    "a claim made seconds ago belongs to a live worker, however old the row",
  );
  const details = await getRunDetails(run.id);
  assertEquals(details?.run.status, "running", "the owning worker keeps its run");
});

Deno.test("a run claimed before claimed_at existed is judged by started_at", async () => {
  const run = await createRun({
    source_key: "soest",
    supplier: "notubiz",
    date_from: "2024-01-01",
    date_to: "2024-12-31",
    trigger: "scheduled",
    execution_mode: "full",
    parent_run_id: undefined,
    projection_version: "test",
    derivation_version: "test",
    status: "queued",
  });
  assert(await claimQueuedRun(run.id), "run can be claimed");
  // As left by a worker running the previous schema: an old row, no stamp.
  const db = new DatabaseSync(Deno.env.get("WOOZI_KV_PATH")!);
  try {
    db.prepare(`UPDATE ingest_run SET started_at = ?, claimed_at = NULL WHERE id = ?`).run(
      new Date(Date.now() - 10 * 60_000).toISOString(),
      run.id,
    );
  } finally {
    db.close();
  }

  const reconciled = await reconcileInterruptedRuns();
  assertEquals(
    reconciled.find((item) => item.id === run.id)?.status,
    "queued",
    "an unstamped old running row is still treated as interrupted",
  );
});
