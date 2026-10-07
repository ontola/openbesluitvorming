// The host agent (scripts/ops_host_agent.py) against a real ops database and a
// fake `docker` that records what it was asked to do.
Deno.env.set("WOOZI_KV_PATH", await Deno.makeTempFile({ suffix: ".sqlite3" }));

import { DatabaseSync } from "node:sqlite";
import { OpsValidationError, validateOpsRequest } from "../src/ops/jobs.ts";
import {
  claimQueuedOpsJob,
  createOpsJob,
  getOpsJob,
  listHostServiceStatus,
} from "../src/ops/store.ts";
import { getOpsHealth } from "../web/ops_health.ts";

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

function rejects(action: "restart_service" | "service_logs", body: unknown): boolean {
  try {
    validateOpsRequest(action, body);
    return false;
  } catch (error) {
    return error instanceof OpsValidationError;
  }
}

const dbPath = Deno.env.get("WOOZI_KV_PATH")!;
// Opening the store creates its tables, as the web container does on start.
await listHostServiceStatus();
const composeDir = await Deno.makeTempDir();
const callLog = `${composeDir}/docker-calls.txt`;
const fakeDocker = `${composeDir}/docker`;

// Two worker replicas and a single web container; `logs` prints eight lines.
await Deno.writeTextFile(
  fakeDocker,
  `#!/bin/sh
echo "$*" >> "${callLog}"
case "$*" in
  *" ps "*)
    echo '{"Service":"worker","State":"running","Status":"Up 2 hours"}'
    echo '{"Service":"worker","State":"running","Status":"Up 2 hours"}'
    echo '{"Service":"openbesluitvorming","State":"running","Health":"","Status":"Up 3 hours","Labels":"com.docker.compose.oneoff=False"}'
    echo '{"Service":"openbesluitvorming","Name":"woozi-openbesluitvorming-run-abc","State":"running","Status":"Up 26 hours","Labels":"com.docker.compose.oneoff=True,com.docker.compose.service=openbesluitvorming"}'
    ;;
  "logs "*)
    echo "coverage: 120/263 sources"
    ;;
  *" logs "*)
    for i in 1 2 3 4 5 6 7 8; do echo "worker-1 | line $i"; done
    ;;
  *" restart "*)
    echo "Container woozi-worker-1  Restarting" >&2
    ;;
esac
`,
);
await Deno.chmod(fakeDocker, 0o755);

async function runAgent(): Promise<{ code: number; output: string }> {
  const result = await new Deno.Command("python3", {
    args: ["scripts/ops_host_agent.py"],
    env: {
      WOOZI_OPS_DB: dbPath,
      WOOZI_COMPOSE_DIR: composeDir,
      WOOZI_DOCKER: fakeDocker,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  return {
    code: result.code,
    output: decoder.decode(result.stdout) + decoder.decode(result.stderr),
  };
}

async function dockerCalls(): Promise<string[]> {
  try {
    return (await Deno.readTextFile(callLog)).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function clearJobs(): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("DELETE FROM ops_job");
  } finally {
    db.close();
  }
}

Deno.test("restart_service and service_logs accept only allow-listed services", () => {
  assert(rejects("restart_service", { service: "caddy" }), "caddy cannot be restarted");
  assert(rejects("restart_service", { service: "sshd" }), "unknown service");
  assert(
    rejects("restart_service", { service: "worker", apply: true, confirm: "quickwit" }),
    "confirm must name the service",
  );
  const restart = validateOpsRequest("restart_service", {
    service: "worker",
    apply: true,
    confirm: "worker",
  });
  assertEquals([restart.params, restart.apply], [{ service: "worker" }, true], "restart");

  assert(rejects("service_logs", { service: "worker", apply: true }), "logs have no apply");
  assert(rejects("service_logs", { service: "worker", lines: 2001 }), "line cap");
  assert(rejects("service_logs", { service: "worker", sinceMinutes: 1441 }), "24h cap");
  assert(rejects("service_logs", { service: "worker", lines: 1.5 }), "whole numbers");
  const logs = validateOpsRequest("service_logs", { service: "caddy" });
  assertEquals(
    logs.params,
    { service: "caddy", sinceMinutes: 60, lines: 200, runs: false },
    "defaults",
  );
});

Deno.test("the Deno worker never claims a host action", async () => {
  clearJobs();
  await createOpsJob({
    action: "service_logs",
    params: { service: "worker", sinceMinutes: 60, lines: 200 },
    apply: false,
    actor: "test",
  });
  assertEquals(await claimQueuedOpsJob(), null, "left for the host agent");
  clearJobs();
});

Deno.test("the host agent records services, runs dry runs and restarts, and trims logs", async () => {
  clearJobs();
  const dryRun = await createOpsJob({
    action: "restart_service",
    params: { service: "worker" },
    apply: false,
    actor: "test",
  });
  const logs = await createOpsJob({
    action: "service_logs",
    params: { service: "worker", sinceMinutes: 30, lines: 5 },
    apply: false,
    actor: "test",
  });

  const first = await runAgent();
  assertEquals(first.code, 0, `agent run: ${first.output}`);

  const dryRunDone = (await getOpsJob(dryRun.id))!;
  assertEquals(dryRunDone.status, "succeeded", "dry run succeeds");
  assert(dryRunDone.output.startsWith("[dry-run] Would run:"), dryRunDone.output);
  assert(dryRunDone.output.includes("2 container(s), running"), dryRunDone.output);

  const logsDone = (await getOpsJob(logs.id))!;
  assertEquals(logsDone.status, "succeeded", "logs succeed");
  assertEquals(
    logsDone.output.trim().split("\n"),
    [
      "worker-1 | line 4",
      "worker-1 | line 5",
      "worker-1 | line 6",
      "worker-1 | line 7",
      "worker-1 | line 8",
    ],
    "the newest `lines` lines",
  );

  let calls = await dockerCalls();
  assert(!calls.some((call) => call.includes(" restart ")), "a dry run restarts nothing");
  assert(
    calls.includes(
      "compose -f docker-compose.production.yml logs --no-color --timestamps --since 30m --tail 5 worker",
    ),
    `logs call: ${calls.join(" / ")}`,
  );

  const services = await listHostServiceStatus();
  assertEquals(
    services.map((row) => [row.service, row.state, row.replicas]),
    [
      ["openbesluitvorming", "running", 1],
      ["openbesluitvorming:run", "running", 1],
      ["worker", "running", 2],
    ],
    "service status recorded",
  );

  const applied = await createOpsJob({
    action: "restart_service",
    params: { service: "worker" },
    apply: true,
    actor: "test",
  });
  await runAgent();
  const appliedDone = (await getOpsJob(applied.id))!;
  assertEquals(appliedDone.status, "succeeded", `restart: ${appliedDone.error}`);
  calls = await dockerCalls();
  assert(calls.includes("compose -f docker-compose.production.yml restart worker"), "restarted");
  clearJobs();
});

Deno.test("the host agent re-checks a row instead of trusting it", async () => {
  clearJobs();
  // Written straight into the table, past the web container's validation.
  const tampered = await createOpsJob({
    action: "restart_service",
    params: { service: "caddy" },
    apply: true,
    actor: "test",
  });
  await runAgent();
  const done = (await getOpsJob(tampered.id))!;
  assertEquals(done.status, "failed", "refused");
  assert(!(await dockerCalls()).some((call) => call.endsWith("restart caddy")), "never ran");
  clearJobs();
});

Deno.test("health reports services and whether the agent is still ticking", async () => {
  await runAgent();
  const options = {
    dataDir: composeDir,
    host: () => Promise.resolve({}),
    extractors: () => Promise.resolve([]),
    quickwit: {
      isReady: () => Promise.resolve(true),
      describeIndex: () => Promise.resolve({}),
      configuredIndexId: "test",
    },
  };
  const fresh = (await getOpsHealth(options)) as { services: Record<string, unknown> };
  assertEquals(fresh.services.agent_stale, false, "just ticked");
  assertEquals((fresh.services.services as unknown[]).length, 3, "three service rows");

  const later = (await getOpsHealth({
    ...options,
    now: () => Date.now() + 5 * 60_000,
  })) as { services: Record<string, unknown> };
  assertEquals(later.services.agent_stale, true, "five minutes without a tick");
});

Deno.test("run containers' logs come from docker logs, one container at a time", async () => {
  clearJobs();
  const job = await createOpsJob({
    action: "service_logs",
    params: validateOpsRequest("service_logs", {
      service: "openbesluitvorming",
      runs: true,
      sinceMinutes: 1440,
    }).params as unknown as Record<string, unknown>,
    apply: false,
    actor: "test",
  });
  await runAgent();
  const done = (await getOpsJob(job.id))!;
  assertEquals(done.status, "succeeded", `run logs: ${done.error}`);
  assertEquals(
    done.output.trim(),
    "woozi-openbesluitvorming-run-abc | coverage: 120/263 sources",
    "prefixed with the container",
  );
  assert(
    (await dockerCalls()).includes(
      "logs --timestamps --since 1440m --tail 200 woozi-openbesluitvorming-run-abc",
    ),
    "docker logs on the run container",
  );
  clearJobs();
});
