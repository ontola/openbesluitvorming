import { __test__ as ibabsClientTest } from "../src/ibabs/client.ts";
import {
  IbabsMeetingExtractor,
  __test__ as ibabsExtractorTest,
} from "../src/ibabs/extractor.ts";
import { normalizeIbabsMotion, normalizeIbabsMotionDocuments } from "../src/ibabs/normalize.ts";
import {
  MeetingIndex,
  normalizeMotionResult,
  parseAgendaPointReference,
  parseMotionDate,
  partyFromProposer,
} from "../src/motions/normalize.ts";
import {
  __test__ as notubizMotionTest,
  isMotionModule,
  normalizeNotubizMotion,
} from "../src/notubiz/motions.ts";
import { projectEntityCommitToQuickwitDocuments } from "../src/quickwit/project.ts";
import { buildEntityCommitEvent } from "../src/events/entity_commit.ts";
import { canonicalAgendaItemId } from "../src/ids.ts";
import { getIbabsSource, getNotubizSource } from "../src/sources/index.ts";
import type { MeetingEntity, MotionEntity } from "../src/types.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const fixture = (name: string) =>
  Deno.readTextFile(new URL(`./fixtures/${name}`, import.meta.url));

Deno.test("iBabs list parsers read registries, entries, values and votes", async () => {
  const lists = ibabsClientTest.parseListsXml(await fixture("ibabs_lists_response.xml"));
  const moties = lists.find((list) => list.ListName === "Moties");
  assert(moties, "expected a Moties registry in GetLists");
  assertEquals(moties.ListId, "b25f250f-d487-4ce5-93b3-efb84d24567a", "moties list id");

  const entries = ibabsClientTest.parseListEntriesXml(
    await fixture("ibabs_list_entries_response.xml"),
  );
  assertEquals(entries.length, 3, "entry count");
  assert(entries[0].EntryId.length > 0, "entry has an id");
  assert(entries[0].MutationDate?.startsWith("2026-"), "entry has a mutation date");

  const detail = ibabsClientTest.parseListEntryXml(
    await fixture("ibabs_list_entry_response.xml"),
    "599efa0d-e8e0-42da-822c-00d57bb3a1fb",
  );
  assertEquals(detail.Values["Status"], "Motie verworpen", "status value");
  assertEquals(detail.Documents.length, 1, "attached document count");

  const votes = ibabsClientTest.parseListEntryVotesXml(
    await fixture("ibabs_list_entry_votes_response.xml"),
  );
  assertEquals(votes.length, 43, "vote record count");
  assertEquals(votes.filter((vote) => vote.Vote === true).length, 18, "votes in favour");
  assertEquals(votes.filter((vote) => vote.Vote === false).length, 25, "votes against");
});

Deno.test("motion status maps onto a normalized result", () => {
  assertEquals(normalizeMotionResult("Motie verworpen"), "verworpen", "verworpen");
  assertEquals(normalizeMotionResult("aangenomen"), "aangenomen", "lowercase aangenomen");
  assertEquals(normalizeMotionResult("Amendement aangehouden"), "aangehouden", "aangehouden");
  assertEquals(normalizeMotionResult("Motie ingetrokken"), "ingetrokken", "ingetrokken");
  // A withdrawn motion is sometimes phrased with both words; withdrawal wins.
  assertEquals(
    normalizeMotionResult("ingetrokken, niet aangenomen"),
    "ingetrokken",
    "withdrawal beats the outcome word",
  );
  assertEquals(
    normalizeMotionResult("gelijke stemming - wordt opnieuw in stemming gebracht"),
    "overig",
    "unrecognised status falls back to overig",
  );
  assertEquals(normalizeMotionResult(undefined), undefined, "missing status stays undefined");
});

Deno.test("iBabs dates and proposers parse without timezone drift", () => {
  assertEquals(parseMotionDate("Jan 29 2026 12:00AM"), "2026-01-29T00:00:00Z", "US format");
  assertEquals(parseMotionDate("29-1-2026"), "2026-01-29T00:00:00Z", "Dutch format");
  assertEquals(parseMotionDate("Sep 19 2019 12:00AM"), "2019-09-19T00:00:00Z", "September");
  assertEquals(parseMotionDate("rubbish"), undefined, "unparseable date");

  assertEquals(partyFromProposer("Passier, C.E. (Charlotte) (Volt)"), "Volt", "trailing fractie");
  assertEquals(
    partyFromProposer("Heuven, M. van (Maarten) (Partij voor de Dieren)"),
    "Partij voor de Dieren",
    "multi-word fractie",
  );
  assertEquals(partyFromProposer("Jansen"), undefined, "no fractie in string");
});

Deno.test("the agenda-point back-reference splits on a literal backslash-n", () => {
  const reference = parseAgendaPointReference(
    "Gemeenteraad 29-1-2026\\n23 Afrondende besluitvorming na debat",
  );
  assert(reference, "expected a parsed reference");
  assertEquals(reference.meetingName, "Gemeenteraad", "meeting name");
  assertEquals(reference.meetingDate, "2026-01-29", "meeting date");
  assertEquals(reference.itemNumber, "23", "agenda item number");
  assertEquals(reference.itemTitle, "Afrondende besluitvorming na debat", "agenda item title");

  // Real newlines show up too, depending on the site's template.
  const withNewline = parseAgendaPointReference("Gemeenteraad 13-11-2025\n5 Programmabegroting");
  assertEquals(withNewline?.itemNumber, "5", "newline variant still parses");

  assertEquals(parseAgendaPointReference("geen datum hier"), undefined, "no date means no link");
});

function meetingFixture(id: string, name: string, startDate: string): MeetingEntity {
  return {
    id,
    type: "Meeting",
    name,
    classification: ["Agenda"],
    start_date: startDate,
    agenda: [
      { id: `${id}:item-1`, title: "Opening", order: 1 },
      {
        id: `${id}:item-23`,
        title: "Afrondende besluitvorming na debat over Versnellingsaanpak Groene Schaalsprong",
        order: 23,
      },
    ],
    source_info: { supplier: "ibabs", source: "utrecht" },
    raw: {},
  };
}

Deno.test("an iBabs motion normalizes with votes, tally and a meeting link", async () => {
  const source = getIbabsSource("utrecht");
  const lists = ibabsClientTest.parseListsXml(await fixture("ibabs_lists_response.xml"));
  const list = lists.find((candidate) => candidate.ListName === "Moties")!;
  const entries = ibabsClientTest.parseListEntriesXml(
    await fixture("ibabs_list_entries_response.xml"),
  );
  const detail = ibabsClientTest.parseListEntryXml(
    await fixture("ibabs_list_entry_response.xml"),
    entries[0].EntryId,
  );
  const votes = ibabsClientTest.parseListEntryVotesXml(
    await fixture("ibabs_list_entry_votes_response.xml"),
  );

  const meetings = new MeetingIndex();
  meetings.add(meetingFixture("meeting:ibabs:gemeente:utrecht:m1", "Gemeenteraad", "2026-01-29T00:00:00Z"));

  const motion = normalizeIbabsMotion(source, list, entries[0], detail, votes, meetings);

  assertEquals(motion.type, "Motion", "entity type");
  assertEquals(
    motion.name,
    "M25 Vergroen Amerhof – Van stenen tapijt naar ontmoetingsplek in het groen",
    "name comes from Onderwerp",
  );
  assertEquals(motion.status, "Motie verworpen", "verbatim status");
  assertEquals(motion.result, "verworpen", "normalized result");
  assertEquals(motion.date, "2026-01-29T00:00:00Z", "motion date");
  assertEquals(motion.proposers, ["Passier, C.E. (Charlotte) (Volt)"], "proposer");
  assertEquals(motion.co_proposers?.length, 3, "co-proposer count");
  assertEquals(motion.parties, ["Volt", "LINK", "Partij voor de Dieren", "EenUtrecht"], "parties");

  assertEquals(motion.votes?.length, 43, "vote count");
  assertEquals(motion.tally, { in_favour: 18, against: 25 }, "tally matches the verworpen status");
  const firstVote = motion.votes![0];
  assertEquals(firstVote.option, "tegen", "first vote option");
  assertEquals(firstVote.group_name, "GroenLinks", "first vote fractie");
  assert(firstVote.voter?.startsWith("person:ibabs:"), "voter resolves to a canonical person id");
  assert(firstVote.group?.startsWith("party:ibabs:"), "group resolves to a canonical party id");

  assertEquals(motion.meeting, "meeting:ibabs:gemeente:utrecht:m1", "linked meeting");
  assertEquals(motion.agenda_item, "meeting:ibabs:gemeente:utrecht:m1:item-23", "linked agenda item");
  assertEquals(motion.agenda_item_hint, undefined, "hint dropped once fully resolved");

  const documents = normalizeIbabsMotionDocuments(source, motion, detail);
  assertEquals(documents.length, 1, "motion document count");
  assertEquals(documents[0].is_referenced_by, motion.id, "document points back at the motion");
});

Deno.test("an unresolvable agenda reference keeps the raw hint", async () => {
  const source = getIbabsSource("utrecht");
  const lists = ibabsClientTest.parseListsXml(await fixture("ibabs_lists_response.xml"));
  const list = lists.find((candidate) => candidate.ListName === "Moties")!;
  const entries = ibabsClientTest.parseListEntriesXml(
    await fixture("ibabs_list_entries_response.xml"),
  );
  const detail = ibabsClientTest.parseListEntryXml(
    await fixture("ibabs_list_entry_response.xml"),
    entries[0].EntryId,
  );

  // Empty index: the meeting falls outside this run's window.
  const motion = normalizeIbabsMotion(source, list, entries[0], detail, [], new MeetingIndex());

  assertEquals(motion.meeting, undefined, "no meeting linked");
  assert(motion.agenda_item_hint?.startsWith("Gemeenteraad 29-1-2026"), "raw hint retained");
  assertEquals(motion.votes, undefined, "no votes means no vote array");
  assertEquals(motion.tally, undefined, "no votes means no tally");
});

Deno.test("motion list selection and the run window bound what gets fetched", () => {
  const pattern = ibabsExtractorTest.MOTION_LIST_PATTERN;
  assert(pattern.test("Moties"), "Moties matches");
  assert(pattern.test("1.2 Amendementen"), "numbered Amendementen matches");
  assert(pattern.test("Stemming"), "Stemming matches");
  assert(!pattern.test("Toezeggingen"), "Toezeggingen is out of scope");
  assert(!pattern.test("Ingekomen stukken"), "Ingekomen stukken is out of scope");

  const inWindow = ibabsExtractorTest.isEntryInWindow;
  assert(inWindow("2026-01-29T19:45:18.133", "2026-01-01", "2026-06-30"), "inside window");
  assert(!inWindow("2025-12-31T10:00:00", "2026-01-01", "2026-06-30"), "before window");
  assert(!inWindow("2026-07-01T10:00:00", "2026-01-01", "2026-06-30"), "after window");
  assert(inWindow(undefined, "2026-01-01", "2026-06-30"), "undated entries are kept");
});

Deno.test("Notubiz motion modules are picked by their canonical name", async () => {
  const modules = JSON.parse(await fixture("notubiz_alkmaar_modules.json")).modules;
  const selected = modules.filter(isMotionModule).map((module: { name: string }) => module.name);
  // Alkmaar renames module 6 to "Moties en Amendementen"; the canonical name
  // stays "Moties", which is what we match on.
  assertEquals(selected, ["Moties"], "only the moties module is selected");
});

Deno.test("a Notubiz motion normalizes with an exact agenda-item link", async () => {
  const source = getNotubizSource("alkmaar");
  const modules = JSON.parse(await fixture("notubiz_alkmaar_modules.json")).modules;
  const module = modules.find(isMotionModule)!;
  const items = JSON.parse(await fixture("notubiz_alkmaar_motions.json")).items;

  const meetings = new MeetingIndex();
  meetings.add({
    id: "meeting:notubiz:gemeente:alkmaar:m1",
    type: "Meeting",
    name: "Gemeenteraad",
    classification: ["Agenda"],
    start_date: "2026-02-19T19:30:00Z",
    agenda: [{ id: canonicalAgendaItemId(source, 9977098), title: "Geotechnisch onderzoek", order: 15 }],
    source_info: { supplier: "notubiz", source: "alkmaar" },
    raw: {},
  });

  const motion = normalizeNotubizMotion(source, module, items[0], meetings);
  assertEquals(motion.type, "Motion", "entity type");
  assert(motion.name.includes("Amendement"), "title from field 1");
  assertEquals(motion.status, "verworpen", "outcome from field 62");
  assertEquals(motion.result, "verworpen", "normalized result");
  assertEquals(motion.agenda_item, canonicalAgendaItemId(source, 9977098), "exact agenda item link");
  assertEquals(motion.meeting, "meeting:notubiz:gemeente:alkmaar:m1", "meeting resolved via agenda item");
  assertEquals(motion.last_discussed_at, "2026-02-19T19:30:00Z", "dated by its meeting");
  assert((motion.parties?.length ?? 0) > 0, "submitting parties from field 37");

  const unlinked = normalizeNotubizMotion(source, module, items[1], new MeetingIndex());
  assertEquals(unlinked.meeting, undefined, "no meeting when the agenda item is unknown");
  assert(unlinked.agenda_item !== undefined, "agenda item reference is still kept");
  assert(unlinked.agenda_item_hint !== undefined, "and so is the human-readable hint");
});

Deno.test("the free-text vote breakdown is kept as published, minus HTML", async () => {
  const source = getNotubizSource("altena");
  const items = JSON.parse(await fixture("notubiz_altena_motions.json")).items;
  const module = { id: 6, name: "Moties" };

  const motion = normalizeNotubizMotion(source, module, items[0], new MeetingIndex());

  assertEquals(motion.result, "aangenomen", "outcome still comes from field 62");
  assertEquals(
    motion.vote_summary,
    "Stemmen voor: 23 CDA, AL, SGP, VVD, FVD, H. Timmermans (VVA), en A. de Weerd (VVA)\n" +
      "Stemmen tegen: 7 PA, CU, A. Visser (VVA) en A. de Jong (VVA)",
    "breakdown kept verbatim as text",
  );
  assert(!motion.vote_summary?.includes("<"), "no supplier HTML reaches the UI");
  assertEquals(motion.votes, undefined, "Notubiz publishes no per-member records");
});

Deno.test("the outcome field wins over prose in the same field", () => {
  const pick = notubizMotionTest.pickStatus;
  const attrs = (entries: Array<[number, string]>) =>
    new Map(entries.map(([id, content]) => [id, { id, values: [{ content }] }]));

  assertEquals(pick(attrs([[62, "aangenomen"]])), "aangenomen", "field 62 is preferred");
  // Some municipalities park prose in 62 and the real outcome in 71.
  assertEquals(
    pick(attrs([[62, "gelijke stemming - wordt opnieuw in stemming gebracht"], [71, "verworpen"]])),
    "verworpen",
    "a decisive field wins over prose",
  );
  // …and when nothing is decisive, keep what the source said.
  assertEquals(
    pick(attrs([[62, "gelijke stemming"]])),
    "gelijke stemming",
    "prose is kept when there is no better candidate",
  );
});

/** A stand-in for IbabsClient that records which date ranges were asked for. */
class FakeIbabsClient {
  readonly meetingRangeCalls: Array<[string, string]> = [];

  constructor(
    private readonly meetingsByDate: Record<string, Array<{ Id: string; MeetingDate: string; Title: string }>>,
    private readonly entries: Array<{ EntryId: string; MutationDate: string; agendapunt: string }>,
  ) {}

  getMeetingTypes() {
    return Promise.resolve([{ Id: "t1", Description: "Gemeenteraad" }]);
  }

  listMeetingsByDateRange(_source: unknown, from: string, to: string) {
    this.meetingRangeCalls.push([from, to]);
    const collected = [];
    for (const [date, meetings] of Object.entries(this.meetingsByDate)) {
      if (date >= from && date <= to) {
        collected.push(...meetings.map((meeting) => ({
          Id: meeting.Id,
          MeetingtypeId: "t1",
          MeetingDate: meeting.MeetingDate,
          MeetingItems: [{ Id: `${meeting.Id}-item5`, Title: meeting.Title, Documents: [] }],
          Documents: [],
        })));
      }
    }
    return Promise.resolve(collected);
  }

  getLists() {
    return Promise.resolve([{ ListId: "list-1", ListName: "Moties" }]);
  }

  listListEntries() {
    return Promise.resolve(
      this.entries.map((entry) => ({
        EntryId: entry.EntryId,
        EntryTitle: `Motie ${entry.EntryId}`,
        MutationDate: entry.MutationDate,
        ListId: "list-1",
        ListName: "Moties",
        ListCanVote: true,
      })),
    );
  }

  getListEntry(_source: unknown, _listId: string, entryId: string) {
    const entry = this.entries.find((candidate) => candidate.EntryId === entryId)!;
    return Promise.resolve({
      EntryId: entryId,
      Values: {
        Onderwerp: `Motie ${entryId}`,
        Status: "Motie aangenomen",
        Agendapunt: entry.agendapunt,
      },
      Documents: [],
    });
  }

  getListEntryVotes() {
    return Promise.resolve([]);
  }
}

Deno.test("motions link to meetings outside the run window, fetching each date once", async () => {
  const source = getIbabsSource("utrecht");
  // Two motions edited in the run window but decided long before it, plus one
  // decided inside it. The first two share a meeting date.
  const client = new FakeIbabsClient(
    {
      "2024-11-07": [{ Id: "old-meeting", MeetingDate: "2024-11-07T19:30:00", Title: "Programmabegroting" }],
      "2026-07-16": [{ Id: "new-meeting", MeetingDate: "2026-07-16T19:30:00", Title: "Voorjaarsnota" }],
    },
    [
      { EntryId: "e1", MutationDate: "2026-07-15T10:00:00", agendapunt: "Gemeenteraad 7-11-2024\\n5 Programmabegroting" },
      { EntryId: "e2", MutationDate: "2026-07-15T11:00:00", agendapunt: "Gemeenteraad 7-11-2024\\n5 Programmabegroting" },
      { EntryId: "e3", MutationDate: "2026-07-16T12:00:00", agendapunt: "Gemeenteraad 16-7-2026\\n5 Voorjaarsnota" },
    ],
  );

  // deno-lint-ignore no-explicit-any
  const extractor = new IbabsMeetingExtractor(client as any, () => Promise.resolve(undefined));
  const motions: MotionEntity[] = [];
  await extractor.extractForDateRange(source, "2026-07-14", "2026-07-18", {
    retainEntities: false,
    onEntity: (entity) => {
      if (entity.type === "Motion") {
        motions.push(entity);
      }
    },
  });

  assertEquals(motions.length, 3, "all three motions imported");
  assertEquals(
    motions.filter((motion) => motion.meeting).length,
    3,
    "every motion links to its meeting, including the 2024 ones",
  );
  assertEquals(
    motions.filter((motion) => motion.agenda_item).length,
    3,
    "and to the agenda item within it",
  );

  const extraLookups = client.meetingRangeCalls.filter(([from, to]) => from === to);
  assertEquals(
    extraLookups,
    [["2024-11-07", "2024-11-07"]],
    "only the out-of-window date is fetched, and only once for both motions that share it",
  );
});

Deno.test("motions_only skips the meeting pass but still links motions", async () => {
  const source = getIbabsSource("utrecht");
  const client = new FakeIbabsClient(
    {
      "2024-11-07": [{ Id: "old-meeting", MeetingDate: "2024-11-07T19:30:00", Title: "Programmabegroting" }],
    },
    [
      { EntryId: "e1", MutationDate: "2026-07-15T10:00:00", agendapunt: "Gemeenteraad 7-11-2024\\n5 Programmabegroting" },
    ],
  );

  // deno-lint-ignore no-explicit-any
  const extractor = new IbabsMeetingExtractor(client as any, () => Promise.resolve(undefined));
  const seen: string[] = [];
  const bundle = await extractor.extractForDateRange(source, "2026-07-14", "2026-07-18", {
    executionMode: "motions_only",
    retainEntities: false,
    onEntity: (entity) => {
      seen.push(entity.type);
    },
  });

  assertEquals(bundle.stats.meeting_count, 0, "no meetings imported");
  assertEquals(seen, ["Motion"], "only the motion is emitted");
  assertEquals(bundle.stats.motion_count, 1, "the motion is counted");

  // The window itself is never queried for meetings; only the referenced day is.
  assertEquals(
    client.meetingRangeCalls,
    [["2024-11-07", "2024-11-07"]],
    "fetches the day the motion points at, and nothing else",
  );
});

Deno.test("a motion projects into a searchable Quickwit document", async () => {
  const source = getIbabsSource("utrecht");
  const lists = ibabsClientTest.parseListsXml(await fixture("ibabs_lists_response.xml"));
  const list = lists.find((candidate) => candidate.ListName === "Moties")!;
  const entries = ibabsClientTest.parseListEntriesXml(
    await fixture("ibabs_list_entries_response.xml"),
  );
  const detail = ibabsClientTest.parseListEntryXml(
    await fixture("ibabs_list_entry_response.xml"),
    entries[0].EntryId,
  );
  const votes = ibabsClientTest.parseListEntryVotesXml(
    await fixture("ibabs_list_entry_votes_response.xml"),
  );
  const meetings = new MeetingIndex();
  meetings.add(meetingFixture("meeting:ibabs:gemeente:utrecht:m1", "Gemeenteraad", "2026-01-29T00:00:00Z"));

  const motion = normalizeIbabsMotion(source, list, entries[0], detail, votes, meetings);
  const event = await buildEntityCommitEvent(motion);
  const [projected] = projectEntityCommitToQuickwitDocuments(event);

  assertEquals(projected.entity_type, "Motion", "projected entity type");
  assertEquals(projected.parent_entity_id, motion.meeting, "motion hangs off its meeting");
  assert(projected.content?.includes("Vergroen Amerhof"), "title is searchable");
  assert(projected.content?.includes("verworpen"), "outcome is searchable");
  assert(projected.content?.includes("Volt"), "submitting party is searchable");
  assert(projected.content?.includes("GroenLinks"), "voting fractie is searchable");
  assertEquals(projected.start_date, "2026-01-29T00:00:00Z", "sorts on the meeting date");
});

Deno.test("an unparseable date is dropped rather than passed to the index", async () => {
  // #184. start_date is a mapped datetime field, and Quickwit parses those
  // strictly: an unparseable value makes it discard the whole document, with a
  // successful-looking ingest response. Verified against 0.8.1 — "onzin", ""
  // and "2024-13-45" all reduced the indexed document count silently. So a bad
  // date must cost one unsorted row, never the entity's presence in search.
  const cases: Array<[string, string | undefined]> = [
    ["2026-01-29T00:00:00Z", "2026-01-29T00:00:00Z"],
    ["2026-01-29", "2026-01-29T00:00:00Z"],
    ["2026-01-29T10:15:30+01:00", "2026-01-29T09:15:30Z"],
    ["onzin", undefined],
    ["2024-13-45", undefined],
    ["", undefined],
    ["   ", undefined],
  ];

  for (const [raw, expected] of cases) {
    const meeting = meetingFixture("meeting:ibabs:gemeente:utrecht:m9", "Gemeenteraad", raw);
    const event = await buildEntityCommitEvent(meeting);
    const [projected] = projectEntityCommitToQuickwitDocuments(event);
    assertEquals(projected.start_date, expected, `start_date for input ${JSON.stringify(raw)}`);
  }
});

Deno.test("the backfill planner splits only where the cap demands it", async () => {
  const { __test__: planner } = await import("../scripts/plan_motion_backfill.ts");

  const windows = planner.yearWindows(2016, "2026-08-04");
  assertEquals(windows.length, 11, "2016 through 2026 inclusive");
  assertEquals(windows[0], ["2016-01-01", "2016-12-31"], "first year is whole");
  assertEquals(windows.at(-1), ["2026-01-01", "2026-08-04"], "current year stops today");

  // The registry filter has to agree with the extractor's, or the planner
  // would size runs against lists the import never reads.
  assertEquals(
    planner.MOTION_LIST_PATTERN.source,
    ibabsExtractorTest.MOTION_LIST_PATTERN.source,
    "planner and extractor select the same registries",
  );
});

Deno.test("a throttled meeting-type call fails a full run but not a motions_only one", async () => {
  const source = getIbabsSource("utrecht");

  class ThrottlingTypes extends FakeIbabsClient {
    override getMeetingTypes(): Promise<never> {
      return Promise.reject(new Error("Request failed 403 for https://wcf.ibabs.eu/api/Public.svc"));
    }
  }

  const entries = [
    { EntryId: "e1", MutationDate: "2026-07-15T10:00:00", agendapunt: "Gemeenteraad 7-11-2024\\n5 Programmabegroting" },
  ];
  const meetings = {
    "2024-11-07": [{ Id: "m", MeetingDate: "2024-11-07T19:30:00", Title: "Programmabegroting" }],
  };

  // motions_only: the run survives and still imports the motion.
  const lenient = new ThrottlingTypes(meetings, entries);
  const motions: MotionEntity[] = [];
  // deno-lint-ignore no-explicit-any
  const bundle = await new IbabsMeetingExtractor(lenient as any, () => Promise.resolve(undefined))
    .extractForDateRange(source, "2026-07-14", "2026-07-18", {
      executionMode: "motions_only",
      retainEntities: false,
      onEntity: (entity) => {
        if (entity.type === "Motion") motions.push(entity);
      },
    });
  assertEquals(motions.length, 1, "the motion is still imported");
  assert(bundle.stats.issue_count >= 1, "and the failure is reported, not swallowed");

  // full: the same failure stops the run, because every meeting name comes
  // from that call and writing hundreds of generic names is worse.
  const strict = new ThrottlingTypes(meetings, entries);
  let thrown: unknown;
  try {
    // deno-lint-ignore no-explicit-any
    await new IbabsMeetingExtractor(strict as any, () => Promise.resolve(undefined))
      .extractForDateRange(source, "2026-07-14", "2026-07-18", { retainEntities: false });
  } catch (error) {
    thrown = error;
  }
  assert(String(thrown).includes("403"), "a full run still fails loudly");
});
