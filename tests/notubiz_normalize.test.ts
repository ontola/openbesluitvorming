import { normalizeNotubizDocuments, normalizeNotubizMeeting } from "../src/notubiz/normalize.ts";
import { getNotubizSource } from "../src/sources/index.ts";
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
    meeting.agenda?.[0]?.id === "agenda_item:notubiz:gemeente:haarlem:7",
    "top-level agenda item id should stay deterministic",
  );
  assert(
    meeting.agenda?.[0]?.agenda_items?.[0]?.id === "agenda_item:notubiz:gemeente:haarlem:8",
    "nested agenda item ids should stay deterministic",
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

Deno.test("meeting responses without a meeting are described, not swallowed", async () => {
  const { describeMeetingResponseError } = await import("../src/notubiz/extractor.ts");

  // Notubiz answers HTTP 200 with an error body rather than a 4xx, so
  // fetchJson never throws and the extractor has to recognise this shape.
  // Verbatim response for a den_haag meeting whose permission_group is not
  // public (observed 2026-08-02).
  const full = describeMeetingResponseError({
    message: "No rights to see this meeting",
    error_code: 45624584670,
  });
  assert(
    full === "No rights to see this meeting (error_code 45624584670)",
    `expected message and code, got ${full}`,
  );

  const messageOnly = describeMeetingResponseError({ message: "No rights to see this meeting" });
  assert(messageOnly === "No rights to see this meeting", `got ${messageOnly}`);

  const codeOnly = describeMeetingResponseError({ error_code: 123 });
  assert(codeOnly === "error_code 123", `got ${codeOnly}`);

  // An empty body must still produce something an operator can act on rather
  // than an empty string, which is what made these drops invisible.
  const empty = describeMeetingResponseError({});
  assert(empty === "no error detail in response", `got ${empty}`);
});

Deno.test("a revised document downloads as its current version, not as /1", async () => {
  // #269: Notubiz keeps every version under document/{id}/{n}. Once a
  // municipality uploads an anonymised copy, /1 goes behind a token and
  // answers 400; the new version is the public one. The payload says which
  // version is current, twice.
  const source = getNotubizSource("haarlem");
  const attributes = JSON.parse(
    await Deno.readTextFile(new URL("./fixtures/notubiz_haarlem_attributes.json", import.meta.url)),
  ) as NotubizOrganizationAttributes;
  const rawMeeting = JSON.parse(
    await Deno.readTextFile(new URL("./fixtures/notubiz_haarlem_meeting.json", import.meta.url)),
  );

  const revised: Record<string, unknown>[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === "object") {
      const record = node as Record<string, unknown>;
      if (Array.isArray(record.versions) && typeof record.id === "number") {
        revised.push(record);
      }
      Object.values(record).forEach(walk);
    }
  };
  walk(rawMeeting);
  assert(revised.length === 2, "the fixture carries two documents");

  // Document 42, as the live API shapes a thrice-uploaded document: url and
  // version both name /3, versions listed newest first.
  revised[0].version = 3;
  revised[0].url = "https://api.notubiz.nl/document/42/3";
  revised[0].versions = [{ id: 3 }, { id: 2 }, { id: 1 }].map((item) => ({
    ...item,
    mime_type: "application/pdf",
    file_name: "memo-participatie-geanonimiseerd.pdf",
  }));
  // Document 43: only the version number, no url.
  revised[1].version = 2;
  delete revised[1].url;

  const meeting = normalizeNotubizMeeting(source, attributes, rawMeeting);
  const documents = normalizeNotubizDocuments(source, meeting);
  const byId = new Map(documents.map((document) => [document.id, document]));
  assert(
    byId.get("document:notubiz:gemeente:haarlem:42")?.original_url ===
      "https://api.notubiz.nl/document/42/3",
    "the payload's url names the current version",
  );
  assert(
    byId.get("document:notubiz:gemeente:haarlem:43")?.original_url ===
      "https://api.notubiz.nl/document/43/2",
    "without a url the version number does",
  );
  assert(
    meeting.agenda?.[0]?.documents?.every((link) => !link.original_url?.endsWith("/1")) ?? true,
    "agenda document links follow the same rule",
  );
});
