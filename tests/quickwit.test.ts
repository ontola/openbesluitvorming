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

Deno.test({
  name: "projects Notubiz commit events into Quickwit and makes them searchable",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
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
      await quickwit.waitUntilReady();
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

      const result = await quickwit.searchEventually("entity_type:Meeting");
      assert(result.num_hits > 0, "expected at least one Meeting hit in Quickwit");
      assert(result.hits.length > 0, "expected Quickwit hits");
    } finally {
      await runCommand(["docker", "compose", "down", "-v"], composeDir);
    }
  },
});
