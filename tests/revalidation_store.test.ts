// Isolate the ops store singleton in a temp database for this file.
Deno.env.set("WOOZI_KV_PATH", await Deno.makeTempFile({ suffix: ".sqlite3" }));

import {
  getRevalidationCursor,
  listConfirmedGoneDocuments,
  recordRevalidationResult,
  setRevalidationCursor,
} from "../src/ops/store.ts";

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("cursor starts at 0 and persists across saves", async () => {
  assertEquals(await getRevalidationCursor("ibabs"), 0, "unset cursor should default to 0");
  await setRevalidationCursor("ibabs", 250);
  assertEquals(await getRevalidationCursor("ibabs"), 250, "cursor should persist");
  // a different supplier's cursor is independent
  assertEquals(await getRevalidationCursor("notubiz"), 0, "cursors are per-supplier");
});

Deno.test("a document needs CONFIRM_THRESHOLD consecutive 'gone' runs before it is reported", async () => {
  const entityId = "document:ibabs:gemeente:steenwijkerland:abc-123";
  for (let run = 1; run <= 2; run++) {
    const streak = await recordRevalidationResult(
      entityId,
      "ibabs",
      "steenwijkerland",
      "gone",
      "https://api1.ibabs.eu/publicdownload.aspx?site=Steenwijkerland&id=abc-123",
    );
    assertEquals(streak, run, `streak should be ${run} after run ${run}`);
    const confirmed = await listConfirmedGoneDocuments("ibabs", 3);
    assertEquals(confirmed.length, 0, "must not be confirmed before the 3rd consecutive miss");
  }

  await recordRevalidationResult(
    entityId,
    "ibabs",
    "steenwijkerland",
    "gone",
    "https://api1.ibabs.eu/publicdownload.aspx?site=Steenwijkerland&id=abc-123",
  );
  const confirmed = await listConfirmedGoneDocuments("ibabs", 3);
  assertEquals(confirmed.length, 1, "confirmed after the 3rd consecutive miss");
  assertEquals(confirmed[0].entity_id, entityId, "confirmed entry should be our document");
  assertEquals(confirmed[0].streak, 3, "streak should be 3");
});

Deno.test("a 'live' result resets the streak instead of merely not incrementing it", async () => {
  const entityId = "document:notubiz:gemeente:tilburg:987";
  await recordRevalidationResult(entityId, "notubiz", "tilburg", "gone", "https://api.notubiz.nl/document/987/1");
  await recordRevalidationResult(entityId, "notubiz", "tilburg", "gone", "https://api.notubiz.nl/document/987/1");
  // source republished it (or an earlier miss was a fluke) -- streak must clear, not just pause
  await recordRevalidationResult(entityId, "notubiz", "tilburg", "live", "https://api.notubiz.nl/document/987/1");
  const streakAfterLive = await recordRevalidationResult(
    entityId,
    "notubiz",
    "tilburg",
    "gone",
    "https://api.notubiz.nl/document/987/1",
  );
  assertEquals(streakAfterLive, 1, "streak must restart at 1 after a live result, not resume at 3");
});
