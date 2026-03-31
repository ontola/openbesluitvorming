import { normalizeNotubizDocuments, normalizeNotubizMeeting } from "../src/notubiz/normalize.ts";
import { getNotubizSource } from "../src/sources/notubiz.ts";
import type { NotubizOrganizationAttributes } from "../src/types.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

Deno.test("normalizeNotubizMeeting and normalizeNotubizDocuments produce deterministic ids and refs", async () => {
  const source = getNotubizSource("haarlem");
  const attributes = JSON.parse(
    await Deno.readTextFile(new URL("./fixtures/notubiz_haarlem_attributes.json", import.meta.url)),
  ) as NotubizOrganizationAttributes;
  const rawMeeting = JSON.parse(
    await Deno.readTextFile(new URL("./fixtures/notubiz_haarlem_meeting.json", import.meta.url)),
  );

  const meeting = normalizeNotubizMeeting(source, attributes, rawMeeting);
  const documents = normalizeNotubizDocuments(source, meeting);

  assert(
    meeting.id === "meeting:notubiz:gemeente:haarlem:123",
    "meeting id should use the canonical scoped grammar",
  );
  assert(
    meeting.organization === "organization:nl:gemeente:haarlem",
    "organization id should use the canonical bestuurslaag-scoped grammar",
  );
  assert(
    meeting.committee === "committee:notubiz:gemeente:haarlem:999",
    "committee id should use the canonical scoped grammar",
  );
  assert(
    JSON.stringify(meeting.agenda) ===
      JSON.stringify([
        "agenda_item:notubiz:gemeente:haarlem:7",
        "agenda_item:notubiz:gemeente:haarlem:8",
      ]),
    "agenda ids should stay deterministic across nested agenda items",
  );
  assert(
    JSON.stringify(meeting.attachment) ===
      JSON.stringify([
        "document:notubiz:gemeente:haarlem:42",
        "document:notubiz:gemeente:haarlem:43",
      ]),
    "attachment ids should stay deterministic across direct and agenda documents",
  );

  assert(documents.length === 2, "expected direct and agenda documents");
  assert(
    documents[0].id === "document:notubiz:gemeente:haarlem:42",
    "first document id should use the canonical scoped grammar",
  );
  assert(
    documents[0].original_url === "https://api.notubiz.nl/document/42/1",
    "document download urls should use the stable Notubiz API endpoint",
  );
  assert(
    documents[0].source_info.organization_type === "gemeente",
    "document source info should preserve bestuurslaag",
  );
  assert(
    documents[1].is_referenced_by === meeting.id,
    "documents should reference the canonical meeting id",
  );
});
