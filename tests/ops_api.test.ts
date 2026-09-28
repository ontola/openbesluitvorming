// Isolate the ops store singleton in a temp database for this file.
Deno.env.set("WOOZI_KV_PATH", await Deno.makeTempFile({ suffix: ".sqlite3" }));

import { DatabaseSync } from "node:sqlite";
import { createOpsHandler, OPS_RATE_LIMIT_PER_MINUTE, tokensMatch } from "../web/ops_api.ts";
import { executeOpsJob, OpsValidationError, validateOpsRequest } from "../src/ops/jobs.ts";
import {
  claimQueuedOpsJob,
  finishOpsJob,
  getOpsJob,
  listRuns,
  reconcileInterruptedOpsJobs,
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

const TOKEN = "test-ops-token-0123456789abcdef";
// An imported source, and one that is switched off but still has data.
const RUNNABLE = "west_betuwe";
const SWITCHED_OFF = "dongen";

function handler(options: { token?: string; now?: () => number } = {}) {
  const lines: string[] = [];
  const handle = createOpsHandler({
    token: "token" in options ? options.token : TOKEN,
    audit: (line) => lines.push(line),
    now: options.now,
  });
  return { handle, lines };
}

function request(
  path: string,
  init: { method?: string; body?: unknown; token?: string | null; actor?: string } = {},
): Request {
  const headers = new Headers();
  const token = init.token === undefined ? TOKEN : init.token;
  if (token !== null) {
    headers.set("authorization", `Bearer ${token}`);
  }
  if (init.actor) {
    headers.set("x-ops-actor", init.actor);
  }
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  return new Request(`http://localhost${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/** Clear the job table so each test starts without a pending apply job. */
function clearJobs(): void {
  const db = new DatabaseSync(Deno.env.get("WOOZI_KV_PATH")!);
  try {
    db.exec("DELETE FROM ops_job");
  } finally {
    db.close();
  }
}

Deno.test("token comparison accepts only the exact token", async () => {
  assert(await tokensMatch(TOKEN, TOKEN), "same token matches");
  assert(!(await tokensMatch(`${TOKEN}x`, TOKEN)), "longer token does not match");
  assert(!(await tokensMatch("", TOKEN)), "empty token does not match");
});

Deno.test("without WOOZI_OPS_TOKEN the route does not exist", async () => {
  for (const token of [undefined, "", "   "]) {
    const { handle } = handler({ token });
    const response = await handle(request("/api/ops/summary"), "1.2.3.4");
    assertEquals(response.status, 404, `token ${JSON.stringify(token)} disables the route`);
  }
});

Deno.test("a missing or wrong token is refused and audited without the token", async () => {
  const { handle, lines } = handler();
  const missing = await handle(request("/api/ops/runs", { token: null }), "1.2.3.4");
  assertEquals(missing.status, 401, "missing token");
  assert(missing.headers.get("www-authenticate")?.startsWith("Bearer"), "challenge header");

  const wrong = await handle(
    request("/api/ops/runs", { token: "not-the-token", actor: "claude" }),
    "1.2.3.4",
  );
  assertEquals(wrong.status, 401, "wrong token");

  assertEquals(lines.length, 2, "one audit line per request");
  const audit = JSON.parse(lines[1]);
  assertEquals(
    [audit.event, audit.outcome, audit.path, audit.actor, audit.status],
    ["ops_request", "invalid_token", "/api/ops/runs", "claude", 401],
    "audit line records the rejection",
  );
  for (const line of lines) {
    assert(!line.includes("not-the-token") && !line.includes(TOKEN), "no token in the audit log");
  }
});

Deno.test("status reads answer directly", async () => {
  const { handle, lines } = handler();
  const runs = await handle(request("/api/ops/runs?limit=5"), "1.2.3.4");
  assertEquals(runs.status, 200, "runs");
  const body = await runs.json();
  assert(Array.isArray(body.runs), "runs list");

  const summary = await handle(request("/api/ops/summary"), "1.2.3.4");
  assertEquals(summary.status, 200, "summary");

  const missing = await handle(request("/api/ops/runs/does-not-exist"), "1.2.3.4");
  assertEquals(missing.status, 404, "unknown run");
  assertEquals(JSON.parse(lines[0]).outcome, "ok", "audited as ok");
});

Deno.test("a mutating action is a dry run unless applied and confirmed", async () => {
  clearJobs();
  const { handle } = handler();

  const dry = await handle(
    request("/api/ops/purge_source", { body: { source: SWITCHED_OFF }, actor: "joep" }),
    "1.2.3.4",
  );
  assertEquals(dry.status, 202, "dry run is queued");
  const { job } = await dry.json();
  assertEquals(
    [job.action, job.apply, job.actor, job.status, job.params.source],
    ["purge_source", false, "joep", "queued", SWITCHED_OFF],
    "dry-run job row",
  );

  const unconfirmed = await handle(
    request("/api/ops/purge_source", { body: { source: SWITCHED_OFF, apply: true } }),
    "1.2.3.4",
  );
  assertEquals(unconfirmed.status, 400, "apply without confirm");

  const wrongTarget = await handle(
    request("/api/ops/purge_source", {
      body: { source: SWITCHED_OFF, apply: true, confirm: RUNNABLE },
    }),
    "1.2.3.4",
  );
  assertEquals(wrongTarget.status, 400, "confirm must name the same source");
});

Deno.test("only one apply job may be queued or running at a time", async () => {
  clearJobs();
  const { handle } = handler();
  const apply = (source: string) =>
    handle(
      request("/api/ops/purge_source", { body: { source, apply: true, confirm: source } }),
      "1.2.3.4",
    );

  const first = await apply(SWITCHED_OFF);
  assertEquals(first.status, 202, "first apply accepted");
  const { job } = await first.json();

  const second = await apply(RUNNABLE);
  assertEquals(second.status, 409, "second apply refused");
  assertEquals((await second.json()).activeJobId, job.id, "409 names the active job");

  const dry = await handle(
    request("/api/ops/purge_source", { body: { source: RUNNABLE } }),
    "1.2.3.4",
  );
  assertEquals(dry.status, 202, "dry runs are not blocked by an apply job");

  const claimed = await claimQueuedOpsJob();
  assertEquals(claimed?.id, job.id, "the oldest job is claimed first");
  assertEquals(await apply(RUNNABLE).then((r) => r.status), 409, "still refused while running");

  await finishOpsJob(job.id, { status: "succeeded" });
  assertEquals(await apply(RUNNABLE).then((r) => r.status), 202, "accepted once it finished");
});

Deno.test("job claiming is atomic", async () => {
  clearJobs();
  const { handle } = handler();
  await handle(request("/api/ops/purge_source", { body: { source: RUNNABLE } }), "1.2.3.4");

  const claims = await Promise.all([claimQueuedOpsJob(), claimQueuedOpsJob()]);
  assertEquals(claims.filter(Boolean).length, 1, "exactly one claimant wins");
  assertEquals(await claimQueuedOpsJob(), null, "nothing left to claim");
});

Deno.test("job status can be read back by id and listed", async () => {
  clearJobs();
  const { handle } = handler();
  const created = await handle(
    request("/api/ops/purge_source", { body: { source: RUNNABLE } }),
    "1.2.3.4",
  );
  const { job } = await created.json();

  const one = await handle(request(`/api/ops/jobs/${job.id}`), "1.2.3.4");
  assertEquals((await one.json()).job.id, job.id, "job by id");

  const list = await handle(request("/api/ops/jobs?status=queued"), "1.2.3.4");
  const body = await list.json();
  assertEquals(
    body.jobs.map((j: { id: string }) => j.id),
    [job.id],
    "listed by status",
  );
});

Deno.test("rerun_source only accepts imported sources and valid windows", () => {
  const invalid = [
    { source: SWITCHED_OFF, dateFrom: "2024-01-01", dateTo: "2024-12-31" },
    { source: "no_such_source", dateFrom: "2024-01-01", dateTo: "2024-12-31" },
    { source: "__supplier__:notubiz", dateFrom: "2024-01-01", dateTo: "2024-12-31" },
    { source: RUNNABLE },
    { source: RUNNABLE, dateFrom: "2024-12-31", dateTo: "2024-01-01" },
    { source: RUNNABLE, dateFrom: "01-01-2024", dateTo: "2024-12-31" },
    { source: RUNNABLE, mode: "reindex_only", dateFrom: "2024-01-01", dateTo: "2024-12-31" },
    { source: RUNNABLE, mode: "rederive_cached" },
  ];
  for (const body of invalid) {
    let rejected = false;
    try {
      validateOpsRequest("rerun_source", body);
    } catch (error) {
      rejected = error instanceof OpsValidationError;
    }
    assert(rejected, `rejects ${JSON.stringify(body)}`);
  }

  const reindex = validateOpsRequest("rerun_source", { source: RUNNABLE, mode: "reindex_only" });
  assertEquals(
    reindex.params,
    { source: RUNNABLE, mode: "reindex_only", dateFrom: "", dateTo: "" },
    "a reindex carries empty dates, like the admin rerun",
  );
});

Deno.test("reenqueue across all sources is confirmed with 'all'", () => {
  const unscoped = validateOpsRequest("reenqueue_failed_windows", {
    apply: true,
    confirm: "all",
    statuses: ["failed"],
    fromYear: "2012",
  });
  assertEquals(unscoped.confirmTarget, "all", "confirm target");
  assertEquals(
    unscoped.params,
    {
      source: null,
      statuses: ["failed"],
      minWindowDays: 20,
      fromYear: "2012",
      toYear: null,
    },
    "normalized params",
  );

  let rejected = false;
  try {
    validateOpsRequest("reenqueue_failed_windows", { statuses: ["succeeded"] });
  } catch (error) {
    rejected = error instanceof OpsValidationError;
  }
  assert(rejected, "unknown status is rejected");
});

Deno.test("the worker executes a rerun job: dry run writes nothing, apply enqueues", async () => {
  const lines: string[] = [];
  const params = { source: RUNNABLE, mode: "full", dateFrom: "2020-01-01", dateTo: "2020-01-31" };
  const before = (await listRuns({ sourceKey: RUNNABLE })).length;

  await executeOpsJob({ action: "rerun_source", params, apply: false }, (l) => lines.push(l));
  assertEquals((await listRuns({ sourceKey: RUNNABLE })).length, before, "dry run adds no run");
  assert(lines[0].startsWith("[dry-run]"), "dry run says so");

  await executeOpsJob({ action: "rerun_source", params, apply: true }, (l) => lines.push(l));
  const runs = await listRuns({ sourceKey: RUNNABLE });
  assertEquals(runs.length, before + 1, "apply enqueues one run");
  assertEquals([runs[0].status, runs[0].trigger], ["queued", "api"], "queued as an api run");

  let failed = false;
  try {
    await executeOpsJob({ action: "rerun_source", params, apply: true }, () => {});
  } catch {
    failed = true;
  }
  assert(failed, "a second rerun of the same window fails while the first is queued");
});

Deno.test("an interrupted job is requeued once, then failed", async () => {
  clearJobs();
  const { handle } = handler();
  const created = await handle(
    request("/api/ops/purge_source", { body: { source: RUNNABLE } }),
    "1.2.3.4",
  );
  const { job } = await created.json();
  const backdateClaim = () => {
    const db = new DatabaseSync(Deno.env.get("WOOZI_KV_PATH")!);
    try {
      db.prepare("UPDATE ops_job SET claimed_at = ? WHERE id = ?").run(
        new Date(Date.now() - 10 * 60_000).toISOString(),
        job.id,
      );
    } finally {
      db.close();
    }
  };

  await claimQueuedOpsJob();
  assertEquals(await reconcileInterruptedOpsJobs(), [], "a fresh claim is left alone");

  backdateClaim();
  await reconcileInterruptedOpsJobs();
  assertEquals((await getOpsJob(job.id))?.status, "queued", "first interruption requeues");

  await claimQueuedOpsJob();
  backdateClaim();
  await reconcileInterruptedOpsJobs();
  const failed = await getOpsJob(job.id);
  assertEquals(failed?.status, "failed", "second interruption fails the job");
  assert(failed?.output.includes("requeued"), "the requeue is visible in the output");
});

Deno.test("the ops endpoint has its own rate limit per token", async () => {
  let now = 1_000_000;
  const { handle } = handler({ now: () => now });
  for (let index = 0; index < OPS_RATE_LIMIT_PER_MINUTE; index += 1) {
    const response = await handle(request("/api/ops/jobs"), "1.2.3.4");
    assertEquals(response.status, 200, `request ${index + 1} is within budget`);
  }
  const limited = await handle(request("/api/ops/jobs"), "5.6.7.8");
  assertEquals(limited.status, 429, "the budget is per token, not per address");
  assert(limited.headers.get("retry-after"), "Retry-After is set");

  now += 60_000;
  assertEquals((await handle(request("/api/ops/jobs"), "1.2.3.4")).status, 200, "budget refills");
});

Deno.test("re-enqueueing failed windows: dry run counts, apply enqueues, active runs are skipped", async () => {
  const { createRun, updateRun } = await import("../src/ops/store.ts");
  const { reenqueueFailedWindows } = await import("../src/ops/reenqueue_failed_windows.ts");
  const source = "alkmaar";
  const failed = await createRun({
    source_key: source,
    supplier: "notubiz",
    date_from: "2013-01-01",
    date_to: "2013-12-31",
    trigger: "backfill",
    execution_mode: "full",
    parent_run_id: undefined,
    status: "queued",
  });
  await updateRun(failed.id, { status: "failed", finished_at: new Date().toISOString() });
  const options = { source, statuses: ["failed" as const], minWindowDays: 20 };

  const lines: string[] = [];
  const dry = await reenqueueFailedWindows({ ...options, apply: false }, (l) => lines.push(l));
  assertEquals([dry.windows, dry.enqueued, dry.skipped], [1, 1, 0], "dry run counts the window");
  assertEquals((await listRuns({ sourceKey: source })).length, 1, "dry run writes nothing");
  assert(
    lines.every((line) => line.startsWith("[dry-run]")),
    "dry-run output",
  );

  const applied = await reenqueueFailedWindows({ ...options, apply: true }, () => {});
  assertEquals(applied.enqueued, 1, "apply enqueues the window");
  const runs = await listRuns({ sourceKey: source, status: "queued" });
  assertEquals(
    runs.map((r) => [r.date_from, r.trigger]),
    [["2013-01-01", "backfill"]],
    "queued",
  );

  const again = await reenqueueFailedWindows({ ...options, apply: true }, () => {});
  assertEquals([again.enqueued, again.skipped], [0, 1], "an active window is skipped");
});

Deno.test("delete_document validates entity ids and is confirmed by id or count", async () => {
  clearJobs();
  const one = `document:notubiz:municipality:${RUNNABLE}:12345`;
  const two = `document:notubiz:municipality:${RUNNABLE}:67890`;

  const single = validateOpsRequest("delete_document", {
    entityIds: [one, one],
    reason: "bsn",
    apply: true,
    confirm: one,
  });
  assertEquals(single.params, { entityIds: [one], reason: "bsn" }, "duplicates collapse");
  assertEquals(single.confirmTarget, one, "one document is confirmed by its id");

  const several = validateOpsRequest("delete_document", { entityIds: [one, two] });
  assertEquals(several.confirmTarget, "2 documents", "several are confirmed by count");
  assertEquals(several.params, { entityIds: [one, two], reason: "takedown" }, "default reason");

  const invalid = [
    {},
    { entityIds: [] },
    { entityIds: "document:notubiz:municipality:x:1" },
    { entityIds: [`meeting:notubiz:municipality:${RUNNABLE}:1`] },
    { entityIds: ["document:notubiz:municipality:no_such_source:1"] },
    { entityIds: [`document:notubiz:municipality:${RUNNABLE}`] },
    { entityIds: [one], reason: "Een vrije zin met spaties" },
    { entityIds: Array.from({ length: 101 }, (_, i) => `${one}${i}`) },
    { entityIds: [one, two], apply: true, confirm: one },
  ];
  for (const body of invalid) {
    let rejected = false;
    try {
      validateOpsRequest("delete_document", body);
    } catch (error) {
      rejected = error instanceof OpsValidationError;
    }
    assert(rejected, `rejects ${JSON.stringify(body).slice(0, 120)}`);
  }

  const { handle } = handler();
  const queued = await handle(
    request("/api/ops/delete_document", { body: { entityIds: [one] }, actor: "joep" }),
    "1.2.3.4",
  );
  assertEquals(queued.status, 202, "a dry-run takedown is queued");
  const { job } = await queued.json();
  assertEquals([job.action, job.apply], ["delete_document", false], "queued as a dry run");
  clearJobs();
});
