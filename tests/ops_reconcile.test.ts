// Isolate the ops store singleton in a temp database for this file.
Deno.env.set("WOOZI_KV_PATH", await Deno.makeTempFile({ suffix: ".sqlite3" }));

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
    assert(await claimQueuedRun(runId), `requeued run can be claimed (interruption ${interruption})`);
    reconciled = await reconcileInterruptedRuns();
    target = reconciled.find((run) => run.id === runId);
    assertEquals(target?.status, "queued", `interruption ${interruption} still requeues`);
  }

  // Sixth restart: the cap is reached; the run fails for good.
  assert(await claimQueuedRun(runId), "run can be claimed a final time");
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
