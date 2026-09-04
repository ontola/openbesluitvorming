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
import { IbabsMeetingExtractor } from "../src/ibabs/extractor.ts";
import { normalizeIbabsRegisterDocuments } from "../src/ibabs/normalize.ts";
import { getIbabsSource } from "../src/sources/index.ts";
import type { ExtractionIssue, IbabsList, IbabsListEntryBase } from "../src/types.ts";

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
  assertEquals(
    first.date_modified,
    "2026-02-05T10:51:47Z",
    "modification time, Dutch wall clock read as UTC",
  );
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

// ---------------------------------------------------------------------------
// iBabs registers
// ---------------------------------------------------------------------------

const INGEKOMEN: IbabsList = { ListId: "list-9", ListName: "Ingekomen stukken" };

Deno.test("an iBabs register entry's documents are classified by the list", () => {
  const source = getIbabsSource("utrecht");
  const entry: IbabsListEntryBase = {
    EntryId: "e-1",
    EntryTitle: "Brief provincie over N201",
    MutationDate: "2026-02-03T10:00:00",
    ListId: INGEKOMEN.ListId,
    ListName: INGEKOMEN.ListName,
    ListCanVote: false,
  };
  const documents = normalizeIbabsRegisterDocuments(source, INGEKOMEN, entry, {
    EntryId: "e-1",
    Values: { Onderwerp: "Brief provincie over N201", "Datum ontvangst": "2026-02-01" },
    Documents: [
      {
        Id: "d-1",
        DisplayName: "Brief provincie",
        FileName: "brief.pdf",
        PublicDownloadURL: "https://api1.ibabs.eu/publicdownload.aspx?d=1",
        FileSize: 1234,
      },
      { Id: "d-2", FileName: "bijlage.pdf", PublicDownloadURL: "https://api1.ibabs.eu/x?d=2" },
    ],
  });
  assertEquals(documents.length, 2, "one document per attachment");
  assertEquals(
    documents[0].id,
    "document:ibabs:gemeente:utrecht:d-1",
    "same id scheme as meeting documents",
  );
  assertEquals(documents[0].classification, ["Ingekomen stukken"], "classified by the list");
  assertEquals(documents[0].name, "Brief provincie", "display name");
  assertEquals(documents[1].name, "bijlage.pdf", "file name when there is no display name");
  assertEquals(documents[0].last_discussed_at, "2026-02-01T00:00:00Z", "dated by the entry's date");
  assertEquals(
    documents[0].is_referenced_by,
    "organization:nl:gemeente:utrecht",
    "the council, absent a meeting",
  );
  assertEquals(
    documents[0].source_info.source_iri,
    "ibabs://utrecht/listentry/e-1",
    "the entry it came from",
  );
});

class FakeIbabsRegisterClient {
  votesCalls = 0;
  downloads: string[] = [];

  getMeetingTypes() {
    return Promise.resolve([{ Id: "t1", Description: "Gemeenteraad" }]);
  }
  listMeetingsByDateRange() {
    return Promise.resolve([]);
  }
  getLists() {
    return Promise.resolve([
      { ListId: "list-1", ListName: "Moties" },
      { ListId: "list-9", ListName: "Ingekomen stukken" },
    ]);
  }
  listListEntries(_source: unknown, listId: string) {
    if (listId === "list-9") {
      return Promise.resolve([
        {
          EntryId: "r-1",
          EntryTitle: "Brief",
          MutationDate: "2026-02-03T10:00:00",
          ListId: "list-9",
          ListName: "Ingekomen stukken",
          ListCanVote: false,
        },
      ]);
    }
    return Promise.resolve([]);
  }
  getListEntry(_source: unknown, _listId: string, entryId: string) {
    return Promise.resolve({
      EntryId: entryId,
      Values: { Onderwerp: "Brief provincie" },
      Documents: [
        { Id: "rd-1", FileName: "brief.pdf", PublicDownloadURL: "https://api1.ibabs.eu/x?d=rd-1" },
      ],
    });
  }
  getListEntryVotes() {
    this.votesCalls += 1;
    return Promise.resolve([]);
  }
  downloadDocument(document: { id: string }) {
    this.downloads.push(document.id);
    return Promise.reject(new Error("no network in tests"));
  }
}

Deno.test("iBabs register entries reach the document path without a vote lookup", async () => {
  const source = getIbabsSource("utrecht");
  const client = new FakeIbabsRegisterClient();
  const extractor = new IbabsMeetingExtractor(
    // deno-lint-ignore no-explicit-any
    client as any,
    () => Promise.resolve(undefined),
  );
  const issues: ExtractionIssue[] = [];
  const bundle = await extractor.extractForDateRange(source, "2026-02-01", "2026-02-28", {
    onIssue: (issue) => {
      issues.push(issue);
    },
  });

  assertEquals(
    client.downloads,
    ["document:ibabs:gemeente:utrecht:rd-1"],
    "the register document is fetched",
  );
  assertEquals(client.votesCalls, 0, "registers carry no votes, so none are asked for");
  assertEquals(bundle.stats.motion_count ?? 0, 0, "a register entry is not a motion");
  assert(
    issues.some((issue) => issue.entity_id === "document:ibabs:gemeente:utrecht:rd-1"),
    "the failed download is reported against the document",
  );
});
