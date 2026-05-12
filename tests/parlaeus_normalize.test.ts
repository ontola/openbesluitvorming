import {
  cleanParlaeusLink,
  normalizeParlaeusAgenda,
  normalizeParlaeusCommittee,
} from "../src/parlaeus/normalize.ts";
import type { ParlaeusSourceDefinition } from "../src/types.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const source: ParlaeusSourceDefinition = {
  key: "apeldoorn",
  label: "Apeldoorn",
  supplier: "parlaeus",
  organizationType: "gemeente",
  allmanakId: 37707,
  cbsId: "GM0200",
  baseUrl: "https://apeldoorn.parlaeus.nl/receive/opendata",
  sessionId: "0e714fff-182d-497d-8874-c9a512eb4914",
};

Deno.test("cleanParlaeusLink strips the duplicated parlaeus prefix", () => {
  const broken =
    "https://maastricht.parlaeus.nlhttps://maastricht.qualigraf.nl/app/public/agenda/abc";
  const fixed = cleanParlaeusLink(broken);
  assert(
    fixed === "https://maastricht.qualigraf.nl/app/public/agenda/abc",
    `expected duplicated parlaeus host to be stripped, got: ${fixed}`,
  );

  const ok = "https://apeldoorn.parlaeus.nl/user/showdoc/action=view/id=1";
  assert(cleanParlaeusLink(ok) === ok, "well-formed links must be left untouched");
  assert(cleanParlaeusLink(undefined) === undefined, "undefined input stays undefined");
});

Deno.test("normalizeParlaeusCommittee marks the council vs ordinary committees", () => {
  const council = normalizeParlaeusCommittee(source, {
    cmid: "abc",
    committeename: "Raadsvergadering",
    committeecode: "Raad",
  });
  assert(council.classification.includes("Council"), "Raadsvergadering must classify as Council");
  assert(council.id === "committee:parlaeus:gemeente:apeldoorn:abc", "canonical committee id");
  assert(
    council.subOrganizationOf === "organization:nl:gemeente:apeldoorn",
    "council linked to gemeente",
  );

  const audit = normalizeParlaeusCommittee(source, {
    cmid: "def",
    committeename: "Audit Comité",
    committeecode: "ACO",
  });
  assert(audit.classification.includes("Committee"), "non-council must classify as Committee");
  assert(!audit.classification.includes("Council"), "non-council must not classify as Council");
});

Deno.test("normalizeParlaeusAgenda turns the API payload into a meeting + documents", () => {
  const { meeting, documents } = normalizeParlaeusAgenda(source, {
    agid: "agenda-1",
    cmid: "committee-1",
    committeecode: "Raad",
    title: "Raadsvergadering 11 januari 2024",
    description: "  ",
    location: "Raadzaal",
    chairman: "Ton Heerts",
    date: "20240111",
    time: "19:00",
    endtime: "20:30",
    cancelled: 0,
    points: [
      {
        apid: "point-1",
        number: "1",
        title: "Opening",
        text: "",
        type: "A",
        documents: [],
      },
      {
        apid: "point-2",
        number: "2",
        title: "Spoeddebat",
        text: "Toelichting bij het spoeddebat.",
        type: "A",
        documents: [
          {
            dcid: "doc-1",
            link: "https://apeldoorn.parlaeus.nl/user/showdoc/action=view/id=1/foo.pdf",
            title: "Raadsbrief",
            type: "Raadsbrief",
          },
          {
            dcid: "doc-1",
            link: "https://apeldoorn.parlaeus.nl/user/showdoc/action=view/id=1/foo.pdf",
            title: "Raadsbrief duplicate",
            type: "Raadsbrief",
          },
        ],
      },
    ],
  });

  assert(meeting.id === "meeting:parlaeus:gemeente:apeldoorn:agenda-1", "canonical meeting id");
  assert(meeting.start_date === "2024-01-11T19:00:00", "compact date + time gets ISO formatted");
  assert(meeting.end_date === "2024-01-11T20:30:00", "endtime gets ISO formatted");
  assert(meeting.status === "confirmed", "non-cancelled meeting is confirmed");
  assert(
    meeting.committee === "committee:parlaeus:gemeente:apeldoorn:committee-1",
    "committee linked",
  );
  assert(meeting.location === "Raadzaal", "location preserved");
  assert(meeting.description === undefined, "blank description must be dropped");
  assert(meeting.agenda?.length === 2, `expected 2 agenda items, got ${meeting.agenda?.length}`);
  assert(meeting.agenda?.[1].order === 2, "agenda items keep their natural order");
  assert(meeting.agenda?.[1].documents?.length === 2, "agenda item exposes its document refs");

  // Document dedup keys on dcid; the duplicate point-2 entry collapses.
  assert(documents.length === 1, `expected 1 deduped document, got ${documents.length}`);
  const [doc] = documents;
  assert(doc.id === "document:parlaeus:gemeente:apeldoorn:doc-1", "canonical document id");
  assert(
    doc.is_referenced_by === "agenda_item:parlaeus:gemeente:apeldoorn:point-2",
    "document references its agenda point",
  );
  assert(doc.file_name === "foo.pdf", "filename comes from the URL trailing segment");
  assert(meeting.attachment?.[0] === doc.id, "meeting attachments include the doc id");
});

Deno.test("normalizeParlaeusAgenda flags cancelled meetings", () => {
  const { meeting } = normalizeParlaeusAgenda(source, {
    agid: "agenda-2",
    cmid: "committee-1",
    title: "Geannuleerd",
    date: "20240115",
    time: "20:00",
    cancelled: 1,
    points: [],
  });
  assert(meeting.status === "cancelled", "cancelled flag must propagate");
  assert(meeting.end_date === meeting.start_date, "missing endtime falls back to start_date");
});
