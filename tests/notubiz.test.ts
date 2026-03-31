import { NotubizMeetingExtractor } from "../src/notubiz/extractor.ts";
import { getNotubizSource } from "../src/sources/notubiz.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const composeDir = new URL("../", import.meta.url);

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

function useLocalS3(): void {
  Deno.env.set("S3_STORAGE_BUCKET_NAME", "woozi");
  Deno.env.set("S3_STORAGE_ENDPOINT", "http://127.0.0.1:9000");
  Deno.env.set("S3_STORAGE_REGION", "us-east-1");
  Deno.env.set("S3_ACCESS_KEY", "woozi");
  Deno.env.set("S3_SECRET_KEY", "woozi-dev-secret");
}

Deno.test({
  name: "extracts one day of public Notubiz meetings for Haarlem",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    useLocalS3();
    await runCommand(["docker", "compose", "down", "-v"], composeDir).catch(() => undefined);
    await runCommand(
      ["docker", "compose", "--profile", "local-s3", "up", "-d", "minio"],
      composeDir,
    );
    await runCommand(
      ["docker", "compose", "--profile", "local-s3", "up", "minio-setup"],
      composeDir,
    );

    try {
      const source = getNotubizSource("haarlem");
      const extractor = new NotubizMeetingExtractor();

      const extraction = await extractor.extractForDateRange(source, "2025-01-14", "2025-01-15");

      assert(Array.isArray(extraction.meetings), "expected meetings array");
      assert(extraction.meetings.length > 0, "expected at least one public meeting");
      assert(Array.isArray(extraction.documents), "expected documents array");
      assert(extraction.documents.length > 0, "expected at least one public document");

      for (const meeting of extraction.meetings) {
        assert(meeting.type === "Meeting", "meeting type should be Meeting");
        assert(
          meeting.id.startsWith("meeting:notubiz:gemeente:haarlem:"),
          "meeting id should be namespaced",
        );
        assert(meeting.name.length > 0, "meeting should have a name");
        assert(meeting.start_date.length > 0, "meeting should have a start_date");
        assert(meeting.classification.includes("Agenda"), "meeting should classify as Agenda");
        assert(meeting.source_info.source === "haarlem", "meeting source should be haarlem");
        assert(meeting.source_info.supplier === "notubiz", "meeting supplier should be notubiz");
        assert(
          meeting.organization === "organization:nl:gemeente:haarlem",
          "meeting organization should be bestuurslaag-scoped",
        );
        assert(
          meeting.committee?.startsWith("committee:notubiz:gemeente:haarlem:") ?? true,
          "meeting committee should be municipality-scoped",
        );
        assert(
          meeting.agenda?.every((item) =>
            item.startsWith("agenda_item:notubiz:gemeente:haarlem:"),
          ) ?? true,
          "meeting agenda ids should be municipality-scoped",
        );
        assert(
          meeting.attachment?.every((item) =>
            item.startsWith("document:notubiz:gemeente:haarlem:"),
          ) ?? true,
          "meeting attachment ids should be municipality-scoped",
        );
      }

      const document = extraction.documents[0];
      assert(document.type === "Document", "document type should be Document");
      assert(
        document.id.startsWith("document:notubiz:gemeente:haarlem:"),
        "document id should be namespaced",
      );
      assert(document.name.length > 0, "document should have a name");
      assert(
        document.original_url?.startsWith("https://api.notubiz.nl/document/"),
        "document should have original_url",
      );
      assert(
        document.media_urls?.[0]?.url?.includes("/documents/notubiz/gemeente/haarlem/"),
        "document should be stored in object storage",
      );
      assert(
        (document.md_text?.[0]?.length ?? 0) > 200,
        "document should include extracted markdown text",
      );
    } finally {
      await runCommand(["docker", "compose", "down", "-v"], composeDir);
    }
  },
});

Deno.test({
  name: "emits entity.commit events for one day of public Notubiz meetings for Haarlem",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    useLocalS3();
    await runCommand(["docker", "compose", "down", "-v"], composeDir).catch(() => undefined);
    await runCommand(
      ["docker", "compose", "--profile", "local-s3", "up", "-d", "minio"],
      composeDir,
    );
    await runCommand(
      ["docker", "compose", "--profile", "local-s3", "up", "minio-setup"],
      composeDir,
    );

    try {
      const source = getNotubizSource("haarlem");
      const extractor = new NotubizMeetingExtractor();

      const events = await extractor.extractCommitEventsForDateRange(
        source,
        "2025-01-14",
        "2025-01-15",
      );

      assert(Array.isArray(events), "expected events array");
      assert(events.length > 0, "expected at least one entity.commit event");

      const meetingEvents = events.filter((event) => event.data.entity_type === "Meeting");
      const documentEvents = events.filter((event) => event.data.entity_type === "Document");
      assert(meetingEvents.length > 0, "expected meeting events");
      assert(documentEvents.length > 0, "expected document events");

      for (const event of events) {
        assert(event.specversion === "1.0", "expected CloudEvents specversion");
        assert(event.type === "entity.commit", "expected entity.commit type");
        assert(event.source === "/woozi/notubiz/haarlem", "expected event source");
        assert(event.data.op === "upsert", "expected upsert op");
        assert(event.data.mode === "replace", "expected replace mode");
        assert(event.data.content_hash.startsWith("sha256:"), "expected content hash");
        assert(event.data.payload?.source_info.source === "haarlem", "expected payload source");
      }

      const documentEvent = documentEvents[0];
      assert(
        documentEvent.subject.startsWith("document:notubiz:gemeente:haarlem:"),
        "expected document subject",
      );
      assert(documentEvent.data.payload?.type === "Document", "expected Document payload");
      assert(
        (documentEvent.data.payload?.md_text?.[0]?.length ?? 0) > 200,
        "expected document payload markdown",
      );
    } finally {
      await runCommand(["docker", "compose", "down", "-v"], composeDir);
    }
  },
});
