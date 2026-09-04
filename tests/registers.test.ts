import { canonicalAgendaItemId } from "../src/ids.ts";
import { MeetingIndex } from "../src/motions/normalize.ts";
import {
  isMotionModule,
  isRegisterModule,
  normalizeNotubizMotion,
  normalizeNotubizMotionDocuments,
  normalizeNotubizRegisterDocuments,
} from "../src/notubiz/motions.ts";
import { getNotubizSource } from "../src/sources/index.ts";
import type { NotubizModule, NotubizModuleItem } from "../src/types.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const fixture = (name: string) => Deno.readTextFile(new URL(`./fixtures/${name}`, import.meta.url));

const INGEKOMEN_STUKKEN: NotubizModule = { id: 1, name: "Ingekomen stukken" };

Deno.test("every module that is not a motion module is a register", async () => {
  // Measured 2026-09-04 (#258): the documents ORI held for Ermelo in 2025 that
  // we lacked sat in "Ingekomen stukken" and "Raadsvoorstellen", not under
  // any agenda item. A register import that had to be told about each module
  // by name would miss the next one an organisation adds.
  const modules = JSON.parse(await fixture("notubiz_alkmaar_modules.json"))
    .modules as NotubizModule[];
  const registers = modules
    .filter(isRegisterModule)
    .map((m) => m.name)
    .sort();
  assertEquals(
    registers,
    [
      "Bestuursdocumenten",
      "Ingekomen stukken",
      "Raadsvoorstellen",
      "Schriftelijke vragen",
      "Toezeggingen",
    ],
    "registers are every non-motion module",
  );
  assert(
    modules.filter(isMotionModule).every((m) => !isRegisterModule(m)),
    "disjoint",
  );
  assert(!isRegisterModule({ id: 9, name: "" }), "a nameless module is neither");
});

Deno.test("a register item's attachments become documents classified by the register", async () => {
  const source = getNotubizSource("ermelo");
  const items = JSON.parse(await fixture("notubiz_ermelo_ingekomen_stukken.json"))
    .items as NotubizModuleItem[];

  const documents = normalizeNotubizRegisterDocuments(source, INGEKOMEN_STUKKEN, items[0]);
  assertEquals(documents.length, 7, "one document per attachment");

  const first = documents[0];
  assertEquals(first.id, "document:notubiz:gemeente:ermelo:16387622", "canonical document id");
  assertEquals(first.type, "Document", "a plain document, no new entity type");
  assertEquals(first.classification, ["Ingekomen stukken"], "classified by the register");
  assertEquals(first.name, "Wegenbeheerplan 2026-2030 e250064948", "the attachment's own title");
  assertEquals(
    first.original_url,
    "https://api.notubiz.nl/document/16387622/1",
    "download URL as Notubiz gives it, version included",
  );
  assertEquals(first.file_name, "Wegenbeheerplan 2026-2030 e250064948.pdf", "file name");
  assertEquals(first.size_in_bytes, 1630609, "size");
  assertEquals(first.content_type, "application/pdf", "mime type");
  assertEquals(first.date_modified, "2026-02-05T10:51:47Z", "modification time, Dutch wall clock read as UTC");
  assertEquals(
    first.last_discussed_at,
    "2025-12-17T00:00:00Z",
    "dated by the item's own date field",
  );
  assertEquals(
    first.is_referenced_by,
    "organization:nl:gemeente:ermelo",
    "without a resolvable meeting the council is the parent",
  );
  assertEquals(
    first.source_info.source_iri,
    "https://api.notubiz.nl/modules/1/items/1114629",
    "the register item it came from",
  );

  // The second attachment is at version 2: the URL and the cache key follow.
  const second = documents[1];
  assertEquals(second.original_url, "https://api.notubiz.nl/document/16504312/2", "versioned URL");
  assertEquals((second.raw as { version: number }).version, 2, "version reaches the cache key");
  assertEquals(second.file_name, "Vraag één-Ermelo.pdf", "file of the current version");
});

Deno.test("a register item linked to a known meeting is referenced by that meeting", async () => {
  const source = getNotubizSource("ermelo");
  const items = JSON.parse(await fixture("notubiz_ermelo_ingekomen_stukken.json"))
    .items as NotubizModuleItem[];
  const meetings = new MeetingIndex();
  meetings.add({
    id: "meeting:notubiz:gemeente:ermelo:m1",
    type: "Meeting",
    name: "Raadsvergadering",
    classification: ["Agenda"],
    start_date: "2025-12-17T19:00:00Z",
    agenda: [{ id: canonicalAgendaItemId(source, 9893143), title: "Ingekomen stukken", order: 1 }],
    source_info: {
      supplier: "notubiz",
      source: "ermelo",
      organization_type: "gemeente",
      canonical_id: "m1",
      canonical_iri: "https://api.notubiz.nl/events/meetings/m1",
    },
    raw: {},
  });

  const documents = normalizeNotubizRegisterDocuments(
    source,
    INGEKOMEN_STUKKEN,
    items[1],
    meetings,
  );
  assertEquals(documents.length, 1, "one attachment");
  assertEquals(
    documents[0].is_referenced_by,
    "meeting:notubiz:gemeente:ermelo:m1",
    "parent meeting",
  );
  assertEquals(documents[0].last_discussed_at, "2025-12-17T19:00:00Z", "dated by the meeting");
});

Deno.test("a confidential attachment is not projected", () => {
  const source = getNotubizSource("ermelo");
  const item: NotubizModuleItem = {
    id: 5,
    attributes: [{ id: 1, label: "Onderwerp", values: [{ content: "Geheim stuk" }] }],
    attachments: {
      document: [
        {
          id: 100,
          url: "https://api.notubiz.nl/document/100/1",
          title: "Openbaar",
          confidential: 0,
        },
        { id: 101, url: "https://api.notubiz.nl/document/101/1", title: "Geheim", confidential: 1 },
      ],
    },
  };
  const documents = normalizeNotubizRegisterDocuments(source, INGEKOMEN_STUKKEN, item);
  assertEquals(
    documents.map((d) => d.name),
    ["Openbaar"],
    "only the public one",
  );
  assertEquals(documents[0].id, "document:notubiz:gemeente:ermelo:100", "id");
});

Deno.test("motion attachments come from the attachment list, not from field 2", async () => {
  // Field 2 carries the document under `value.document` with `meta_data: null`,
  // so the old filter on `meta_data.reference_model` matched nothing and
  // motions shipped without attachments. The attachment list is what Notubiz
  // maintains, and it is what a register item carries too.
  const source = getNotubizSource("ermelo");
  const items = JSON.parse(await fixture("notubiz_ermelo_ingekomen_stukken.json"))
    .items as NotubizModuleItem[];
  const module: NotubizModule = { id: 6, name: "Moties" };
  const motion = normalizeNotubizMotion(source, module, items[1]);
  const documents = normalizeNotubizMotionDocuments(source, motion, items[1]);
  assertEquals(documents.length, 1, "the attachment is materialised");
  assertEquals(documents[0].is_referenced_by, motion.id, "referenced by the motion");
  assertEquals(documents[0].classification, ["Moties"], "classified as the motion type");
});
