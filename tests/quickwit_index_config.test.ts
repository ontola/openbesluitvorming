import { assertEquals, assertThrows } from "jsr:@std/assert";
import { applyIndexConfigOverrides, getIngestCommitMode } from "../src/quickwit/client.ts";

const checkedIn = JSON.parse(
  await Deno.readTextFile(new URL("../quickwit/index-config.json", import.meta.url)),
) as Record<string, unknown>;

Deno.test("the checked-in config still carries the churn-producing commit timeout", () => {
  // Documented, not endorsed: the next index must override this at creation.
  const settings = checkedIn.indexing_settings as Record<string, unknown>;
  assertEquals(settings.commit_timeout_secs, 1);
  assertEquals("index_uri" in checkedIn, false);
});

Deno.test("only the id is patched when nothing else is asked for", () => {
  const result = applyIndexConfigOverrides(checkedIn, { indexId: "woozi-events-x" });
  assertEquals(result.index_id, "woozi-events-x");
  assertEquals("index_uri" in result, false);
  assertEquals(result.indexing_settings, checkedIn.indexing_settings);
  assertEquals(result.doc_mapping, checkedIn.doc_mapping);
});

Deno.test("index_uri and commit_timeout_secs are applied without touching the rest", () => {
  const result = applyIndexConfigOverrides(checkedIn, {
    indexId: "woozi-events-v4",
    indexUri: "file:///quickwit/qwdata/indexes-prod/woozi-events-v4",
    commitTimeoutSecs: 60,
  });
  assertEquals(result.index_uri, "file:///quickwit/qwdata/indexes-prod/woozi-events-v4");
  assertEquals((result.indexing_settings as Record<string, unknown>).commit_timeout_secs, 60);
  assertEquals(result.doc_mapping, checkedIn.doc_mapping);
  assertEquals(result.search_settings, checkedIn.search_settings);
  // The input is not mutated: ensureIndex reads the file once per process.
  assertEquals((checkedIn.indexing_settings as Record<string, unknown>).commit_timeout_secs, 1);
});

Deno.test("ingest commit mode defaults to wait_for and rejects nonsense", () => {
  Deno.env.delete("QUICKWIT_INGEST_COMMIT");
  assertEquals(getIngestCommitMode(), "wait_for");
  Deno.env.set("QUICKWIT_INGEST_COMMIT", "");
  assertEquals(getIngestCommitMode(), "wait_for");
  Deno.env.set("QUICKWIT_INGEST_COMMIT", "auto");
  assertEquals(getIngestCommitMode(), "auto");
  Deno.env.set("QUICKWIT_INGEST_COMMIT", "yes please");
  assertThrows(() => getIngestCommitMode(), Error, "QUICKWIT_INGEST_COMMIT");
  Deno.env.delete("QUICKWIT_INGEST_COMMIT");
});
