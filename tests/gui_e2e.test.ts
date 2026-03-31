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

async function runCommand(command: string[], cwd: URL): Promise<void> {
  const process = new Deno.Command(command[0], {
    args: command.slice(1),
    cwd: cwd.pathname,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await process.output();
  if (output.code !== 0) {
    throw new Error(`${command.join(" ")} failed:\n${new TextDecoder().decode(output.stderr)}`);
  }
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
    const webPort = 8787;

    await runCommand(["docker", "compose", "down", "-v"], composeDir).catch(() => undefined);
    await runCommand(
      ["docker", "compose", "--profile", "local-s3", "up", "-d", "minio"],
      composeDir,
    );
    await runCommand(
      ["docker", "compose", "--profile", "local-s3", "up", "minio-setup"],
      composeDir,
    );
    await runCommand(["docker", "compose", "up", "-d", "quickwit"], composeDir);

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
      await quickwit.ingestMeetingEvents(events);
      await quickwit.searchEventually(`entity_type:Meeting AND source_key:${source.key}`);

      const importedMeetingName = events[0]?.data.payload?.name;
      assert(importedMeetingName, "expected imported meeting to have a name");
      const queryTerm =
        importedMeetingName.split(/\W+/).find((part) => part.length >= 4) ?? importedMeetingName;

      await runCommand(["docker", "compose", "up", "-d", "openbesluitvorming"], composeDir);
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

      await waitFor(() => resultList.textContent?.includes(importedMeetingName) ?? false);

      assert(
        resultList.textContent?.includes("Gemeente Haarlem"),
        "expected rendered GUI results to mention Gemeente Haarlem",
      );
      assert(
        resultList.textContent?.includes(importedMeetingName),
        "expected rendered GUI results to mention the imported meeting title",
      );
    } finally {
      await runCommand(["docker", "compose", "down", "-v"], composeDir);
    }
  },
});
