// Isolate the ops store singleton in a temp database for this file.
Deno.env.set("WOOZI_KV_PATH", await Deno.makeTempFile({ suffix: ".sqlite3" }));

import { DatabaseSync } from "node:sqlite";
import { createRun, getIngestStatus } from "../src/ops/store.ts";
import type { IngestRunRecord } from "../src/types.ts";

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

/** createRun always stamps `started_at` with now, so a fixture that needs a
 * history has to be moved back into it by hand. */
function backdate(runId: string, hoursAgo: number, finished = true): void {
  const db = new DatabaseSync(Deno.env.get("WOOZI_KV_PATH")!);
  try {
    const startedAt = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
    const finishedAt = new Date(Date.now() - (hoursAgo - 0.1) * 3_600_000).toISOString();
    db.prepare(`UPDATE ingest_run SET started_at = ?, finished_at = ? WHERE id = ?`).run(
      startedAt,
      finished ? finishedAt : null,
      runId,
    );
  } finally {
    db.close();
  }
}

async function recordRun(options: {
  sourceKey: string;
  supplier: string;
  status: IngestRunRecord["status"];
  hoursAgo: number;
  errorMessage?: string;
  executionMode?: IngestRunRecord["execution_mode"];
}): Promise<string> {
  const run = await createRun({
    source_key: options.sourceKey,
    supplier: options.supplier,
    date_from: "2026-01-01",
    date_to: "2026-12-31",
    trigger: "scheduled",
    execution_mode: options.executionMode ?? "full",
    parent_run_id: undefined,
    projection_version: "test",
    derivation_version: "test",
    status: options.status,
  });

  if (options.errorMessage) {
    const db = new DatabaseSync(Deno.env.get("WOOZI_KV_PATH")!);
    try {
      db.prepare(`UPDATE ingest_run SET error_message = ? WHERE id = ?`).run(
        options.errorMessage,
        run.id,
      );
    } finally {
      db.close();
    }
  }

  backdate(run.id, options.hoursAgo);
  return run.id;
}

Deno.test("getIngestStatus reports the newest run and the newest success per source", async () => {
  await recordRun({ sourceKey: "soest", supplier: "ibabs", status: "succeeded", hoursAgo: 240 });
  await recordRun({ sourceKey: "soest", supplier: "ibabs", status: "partial", hoursAgo: 100 });
  await recordRun({
    sourceKey: "soest",
    supplier: "ibabs",
    status: "failed",
    hoursAgo: 12,
    errorMessage: "iBabs blocks requests from this host",
  });
  await recordRun({
    sourceKey: "west_betuwe",
    supplier: "notubiz",
    status: "succeeded",
    hoursAgo: 2,
  });

  const status = await getIngestStatus(36);
  const soest = status.sources.find((row) => row.sourceKey === "soest");
  assert(soest, "soest should be reported");

  assertEquals(soest.lastRunStatus, "failed", "the newest run wins, whatever its outcome");
  assertEquals(soest.lastErrorMessage, "iBabs blocks requests from this host", "with its reason");
  assert(soest.lastSuccessAt, "the newest success is reported separately");
  // The `partial` at 100 hours, not the `succeeded` at 240: a partial run
  // reached the source and most of it landed.
  const successAge = (Date.now() - Date.parse(soest.lastSuccessAt)) / 3_600_000;
  assert(
    successAge > 99 && successAge < 101,
    `last success should be the ~100h partial run, was ${successAge.toFixed(1)}h`,
  );

  assertEquals(status.sources.length, 2, "one row per source that has ever run");
});

Deno.test("getIngestStatus counts runs per supplier inside the window only", async () => {
  const status = await getIngestStatus(36);

  const ibabs = status.supplierWindows.find((row) => row.supplier === "ibabs");
  assert(ibabs, "ibabs should have a window");
  // Only the 12h failure falls inside 36 hours; the 100h and 240h runs do not.
  assertEquals(ibabs.runCount, 1, "runs older than the window are excluded");
  assertEquals(ibabs.succeededCount, 0, "no iBabs run succeeded in the window");
  assertEquals(ibabs.failedCount, 1, "the failure is counted");
  assertEquals(
    ibabs.lastErrorMessage,
    "iBabs blocks requests from this host",
    "one representative error per supplier, not one per source",
  );

  const notubiz = status.supplierWindows.find((row) => row.supplier === "notubiz");
  assert(notubiz, "notubiz should have a window");
  assertEquals(notubiz.succeededCount, 1, "a succeeded run counts as a success");
  assertEquals(notubiz.lastErrorMessage, undefined, "a supplier with no failures has no error");
});

Deno.test("getIngestStatus counts a partial run as a success", async () => {
  await recordRun({
    sourceKey: "alblasserdam",
    supplier: "gemeenteoplossingen",
    status: "partial",
    hoursAgo: 1,
  });

  const status = await getIngestStatus(36);
  const window = status.supplierWindows.find((row) => row.supplier === "gemeenteoplossingen");
  assert(window, "gemeenteoplossingen should have a window");
  assertEquals(window.succeededCount, 1, "partial is a success, not a failure");
  assertEquals(window.failedCount, 0, "and is not counted twice");
});

Deno.test("a reindex does not count as the source having been reached", async () => {
  // While iBabs had this server blocked, 164 iBabs sources recorded a
  // *succeeded* reindex_only run. A reindex replays the export log and never
  // calls the supplier, so counting it would report those municipalities as
  // current in the middle of an eleven-day outage.
  await recordRun({
    sourceKey: "aalten",
    supplier: "ibabs",
    status: "failed",
    hoursAgo: 12,
    errorMessage: "iBabs blocks requests from this host",
  });
  await recordRun({
    sourceKey: "aalten",
    supplier: "ibabs",
    status: "succeeded",
    hoursAgo: 1,
    executionMode: "reindex_only",
  });

  const status = await getIngestStatus(36);
  const aalten = status.sources.find((row) => row.sourceKey === "aalten");
  assert(aalten, "aalten should be reported");
  assertEquals(aalten.lastRunStatus, "failed", "the reindex is not the newest run that counts");
  assertEquals(aalten.lastSuccessAt, undefined, "and it is not a success either");

  const ibabs = status.supplierWindows.find((row) => row.supplier === "ibabs");
  assert(ibabs, "ibabs should have a window");
  assertEquals(ibabs.succeededCount, 0, "a supplier-wide outage is not masked by replays");
});
