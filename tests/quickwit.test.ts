import { QuickwitClient } from "../src/quickwit/client.ts";
import { NotubizMeetingExtractor } from "../src/notubiz/extractor.ts";
import { getNotubizSource } from "../src/sources/notubiz.ts";
import { ObjectStorageClient } from "../src/storage/s3.ts";

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

Deno.test({
  name: "projects Notubiz commit events into Quickwit and makes them searchable",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    useLocalS3();
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
      await quickwit.ingestEvents(events);

      const result = await quickwit.searchEventually('entity_type:Document AND "garantiestelling"');
      assert(result.num_hits > 0, "expected at least one Document hit in Quickwit");
      assert(result.hits.length > 0, "expected Quickwit hits");

      const snippetResult = await quickwit.search(
        'entity_type:Document AND "garantiestelling"',
        1,
        {
          snippetFields: ["content"],
        },
      );
      assert(snippetResult.snippets?.length, "expected Quickwit snippets");
      assert(
        snippetResult.snippets?.[0]?.content?.[0]?.includes("<b>garantiestelling</b>"),
        "expected highlighted snippet content",
      );

      const documentEvent = events.find((event) => event.data.entity_type === "Document");
      assert(documentEvent?.data.payload?.type === "Document", "expected a document payload");
      const storedUrl = documentEvent.data.payload.media_urls?.[0]?.url;
      assert(storedUrl, "expected document to be stored in object storage");
      const key = decodeURIComponent(new URL(storedUrl).pathname.split("/").slice(2).join("/"));
      const storage = await ObjectStorageClient.fromEnvironment();
      assert(await storage.hasObject(key), "expected stored document object to exist in S3");
    } finally {
      await runCommand(["docker", "compose", "down", "-v"], composeDir);
    }
  },
});
