import { QuickwitClient } from "../src/quickwit/client.ts";
import { NotubizMeetingExtractor } from "../src/notubiz/extractor.ts";
import { getNotubizSource } from "../src/sources/index.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const composeDir = new URL("../", import.meta.url);
const quickwitConfigPath = new URL("../quickwit/index-config.json", import.meta.url);

function useLocalS3(): void {
  Deno.env.set("S3_STORAGE_BUCKET_NAME", "woozi");
  Deno.env.set("S3_STORAGE_ENDPOINT", "http://127.0.0.1:9000");
  Deno.env.set("S3_STORAGE_REGION", "us-east-1");
  Deno.env.set("S3_ACCESS_KEY", "woozi");
  Deno.env.set("S3_SECRET_KEY", "woozi-dev-secret");
}

async function runCommand(
  command: string[],
  cwd: URL,
  env?: Record<string, string>,
): Promise<void> {
  const process = new Deno.Command(command[0], {
    args: command.slice(1),
    cwd: cwd.pathname,
    stdout: "piped",
    stderr: "piped",
    env,
  });
  const output = await process.output();
  if (output.code !== 0) {
    throw new Error(`${command.join(" ")} failed:\n${new TextDecoder().decode(output.stderr)}`);
  }
}

function localComposeS3Env(): Record<string, string> {
  return {
    S3_STORAGE_BUCKET_NAME: "woozi",
    S3_STORAGE_ENDPOINT: "http://minio:9000",
    S3_STORAGE_REGION: "us-east-1",
    S3_ACCESS_KEY: "woozi",
    S3_SECRET_KEY: "woozi-dev-secret",
  };
}

/** Like waitFor, but hands back the first truthy value instead of discarding
 * it, so a poll can double as the lookup. */
async function waitFor2<T>(
  produce: () => Promise<T | null> | T | null,
  timeoutMs = 10000,
  pollIntervalMs = 200,
): Promise<T | null> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const value = await produce();
    if (value) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return null;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10000,
  pollIntervalMs = 200,
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error("Timed out while waiting for condition");
}

/** End-to-end: a real Notubiz meeting, indexed, and then found through the
 * HTTP surface the app actually calls.
 *
 * This used to drive `web/src/app.ts` -- the pre-Svelte GUI -- through
 * happy-dom, asserting on `#search-form` and `#result-list`. Those elements
 * stopped existing at the Svelte migration and nothing referenced that module
 * any more, so the test was exercising an interface no visitor could reach.
 * Asserting on /api/search keeps the part that carries the value (supplier ->
 * extractor -> Quickwit -> served container) and drops only the dead GUI.
 *
 * Opt-in: it needs Docker, minio, the live Notubiz API and the PDF extraction
 * fleet, which is reachable from production and not from a laptop. */
const LIVE = Deno.env.get("WOOZI_RUN_LIVE_INTEGRATION") === "1";

Deno.test({
  name: "imports meetings into Quickwit and serves them over the search API",
  ignore: !LIVE,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    useLocalS3();
    const webPort = 8787;

    await runCommand(["docker", "compose", "down", "-v"], composeDir).catch(() => undefined);
    await runCommand(
      ["docker", "compose", "--profile", "local-s3", "up", "-d", "minio"],
      composeDir,
      localComposeS3Env(),
    );
    await runCommand(
      ["docker", "compose", "--profile", "local-s3", "up", "minio-setup"],
      composeDir,
      localComposeS3Env(),
    );
    await runCommand(
      ["docker", "compose", "up", "-d", "quickwit"],
      composeDir,
      localComposeS3Env(),
    );

    try {
      const quickwit = new QuickwitClient();
      await quickwit.waitUntilReady(40000);
      await quickwit.ensureIndex(quickwitConfigPath.pathname);

      const source = getNotubizSource("haarlem");
      const extractor = new NotubizMeetingExtractor();
      const events = await extractor.extractCommitEventsForDateRange(
        source,
        "2025-01-14",
        "2025-01-15",
      );

      assert(events.length > 0, "expected at least one event to ingest into Quickwit");
      await quickwit.ingestEvents(events);
      await quickwit.searchEventually(
        `entity_type:Document AND source_key:${source.key} AND "garantiestelling"`,
      );

      const importedDocument = events.find((event) => event.data.entity_type === "Document")?.data
        .payload;
      assert(importedDocument?.type === "Document", "expected imported document payload");
      const queryTerm = "garantiestelling";

      await runCommand(
        ["docker", "compose", "up", "-d", "--build", "openbesluitvorming"],
        composeDir,
        localComposeS3Env(),
      );
      await waitFor(async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${webPort}/`);
          return response.ok;
        } catch {
          return false;
        }
      }, 30000);

      const found = await waitFor2(async () => {
        const response = await fetch(
          `http://127.0.0.1:${webPort}/api/search?query=${encodeURIComponent(queryTerm)}` +
            `&organization=${encodeURIComponent(source.key)}&limit=25`,
        );
        if (!response.ok) {
          return null;
        }
        const body = (await response.json()) as {
          results?: Array<{ name?: string; organization?: string }>;
        };
        return body.results?.find((result) => result.name === importedDocument.name) ?? null;
      }, 30000);

      assert(found, "expected the imported document to be findable through /api/search");
      assert(
        found.organization?.toLowerCase().includes("haarlem"),
        `expected the hit to name Haarlem, got ${found.organization}`,
      );
    } finally {
      await runCommand(["docker", "compose", "down", "-v"], composeDir);
    }
  },
});
