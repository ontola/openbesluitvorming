import {
  canonicalAgendaItemId,
  canonicalCommitteeId,
  canonicalDocumentId,
  canonicalMeetingId,
  canonicalOrganizationId,
} from "../src/ids.ts";
import { getNotubizSource } from "../src/sources/notubiz.ts";

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}\nexpected: ${expected}\nactual:   ${actual}`);
  }
}

Deno.test("identifier helpers use one deterministic grammar", () => {
  const source = getNotubizSource("haarlem");

  assertEquals(
    canonicalOrganizationId(source),
    "organization:nl:gemeente:haarlem",
    "organization id should use canonical NL bestuurslaag scope",
  );
  assertEquals(
    canonicalMeetingId(source, 123),
    "meeting:notubiz:gemeente:haarlem:123",
    "meeting id should include supplier, bestuurslaag, source key, and native id",
  );
  assertEquals(
    canonicalDocumentId(source, "42"),
    "document:notubiz:gemeente:haarlem:42",
    "document id should include supplier, bestuurslaag, source key, and native id",
  );
  assertEquals(
    canonicalCommitteeId(source, 9),
    "committee:notubiz:gemeente:haarlem:9",
    "committee id should include supplier, bestuurslaag, source key, and native id",
  );
  assertEquals(
    canonicalAgendaItemId(source, 7),
    "agenda_item:notubiz:gemeente:haarlem:7",
    "agenda item id should include supplier, bestuurslaag, source key, and native id",
  );
});
