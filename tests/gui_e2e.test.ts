import { Window } from "npm:happy-dom";
import { bootstrapSearchApp } from "../web/app.js";
import { QuickwitClient } from "../src/quickwit/client.ts";
import { NotubizMeetingExtractor } from "../src/notubiz/extractor.ts";
import { getNotubizSource } from "../src/sources/notubiz.ts";

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

Deno.test({
  name: "imports meetings into Quickwit and finds them through the OpenBesluitvorming GUI",
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

      const html = await fetch(`http://127.0.0.1:${webPort}/`).then((response) => response.text());
      const window = new Window();
      window.document.write(html);
      window.document.close();

      await bootstrapSearchApp({
        document: window.document,
        fetchImpl: (input) => {
          const url =
            typeof input === "string" ? new URL(input, `http://127.0.0.1:${webPort}`) : input;

          return fetch(url);
        },
      });

      const form = window.document.querySelector("#search-form") as {
        dispatchEvent: (event: Event) => boolean;
      } | null;
      const queryInput = window.document.querySelector("#query") as { value: string } | null;
      const organizationSelect = window.document.querySelector("#organization") as {
        value: string;
      } | null;
      const resultList = window.document.querySelector("#result-list");

      assert(form, "expected search form");
      assert(queryInput, "expected query input");
      assert(organizationSelect, "expected organization select");
      assert(resultList, "expected result list");

      queryInput.value = queryTerm;
      organizationSelect.value = source.key;
      form.dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
      );

      await waitFor(() => resultList.textContent?.includes(importedDocument.name) ?? false);

      assert(
        resultList.textContent?.includes("Gemeente Haarlem"),
        "expected rendered GUI results to mention Gemeente Haarlem",
      );
      assert(
        resultList.textContent?.includes(importedDocument.name),
        "expected rendered GUI results to mention the imported document title",
      );
    } finally {
      await runCommand(["docker", "compose", "down", "-v"], composeDir);
    }
  },
});
