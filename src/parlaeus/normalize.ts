import {
  canonicalAgendaItemId,
  canonicalCommitteeId,
  canonicalDocumentId,
  canonicalMeetingId,
  canonicalOrganizationId,
} from "../ids.ts";
import type {
  CommitteeEntity,
  DocumentEntity,
  MeetingAgendaItem,
  MeetingEntity,
  SourceDefinitionBase,
} from "../types.ts";
import type {
  ParlaeusAgendaDetail,
  ParlaeusAgendaPoint,
  ParlaeusCommittee,
  ParlaeusDocumentRef,
} from "./client.ts";

function compactToIsoDate(date: string | undefined): string | undefined {
  if (!date || date.length !== 8) {
    return undefined;
  }
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
}

function isoStartDate(date: string | undefined, time: string | undefined): string {
  const isoDate = compactToIsoDate(date) ?? "1970-01-01";
  if (time && /^\d{1,2}:\d{2}$/.test(time)) {
    const [hours, minutes] = time.split(":");
    return `${isoDate}T${hours.padStart(2, "0")}:${minutes}:00`;
  }
  return `${isoDate}T00:00:00`;
}

function isoEndDate(date: string | undefined, endtime: string | undefined): string | undefined {
  if (!endtime || endtime === "0" || !/^\d{1,2}:\d{2}$/.test(endtime)) {
    return undefined;
  }
  const isoDate = compactToIsoDate(date);
  if (!isoDate) {
    return undefined;
  }
  const [hours, minutes] = endtime.split(":");
  return `${isoDate}T${hours.padStart(2, "0")}:${minutes}:00`;
}

// Parlaeus occasionally returns links of the form
//   https://maastricht.parlaeus.nlhttps://maastricht.parlaeus.nl/...
//   https://maastricht.parlaeus.nlhttps://maastricht.qualigraf.nl/...
//   https://maastricht.qualigraf.nlhttps//maastricht.parlaeus.nl/...
// where some host got concatenated directly onto a second, fully-qualified
// URL -- the prefix host isn't always parlaeus.nl, and the glued-on link's
// own "://" is sometimes missing its colon. Strip the erroneous prefix (and
// restore the colon) so downstream HTTP fetches don't fail with a DNS error
// on the combined, nonexistent host.
export function cleanParlaeusLink(link: string | undefined): string | undefined {
  if (!link) {
    return undefined;
  }
  const match = link.match(/^https?:\/\/[^/]+(https?):?(\/\/[^/]+\/.*)$/);
  if (match) {
    return `${match[1]}:${match[2]}`;
  }
  return link;
}

function fileNameFromUrl(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  const trailing = url.split("/").pop();
  if (!trailing) {
    return undefined;
  }
  return trailing.toLowerCase().endsWith(".pdf") ? trailing : undefined;
}

export function normalizeParlaeusCommittee(
  source: SourceDefinitionBase,
  committee: ParlaeusCommittee,
): CommitteeEntity {
  const id = canonicalCommitteeId(source, committee.cmid);
  const name = committee.committeename?.trim() || committee.committeecode?.trim() || committee.cmid;
  const isCouncil = /^raad/i.test(name) || committee.committeecode?.toLowerCase() === "raad";
  return {
    id,
    type: "Committee",
    name,
    classification: isCouncil ? ["Council"] : ["Committee"],
    subOrganizationOf: canonicalOrganizationId(source),
    source_info: {
      supplier: source.supplier,
      source: source.key,
      organization_type: source.organizationType,
      canonical_id: committee.cmid,
    },
    raw: committee,
  };
}

function normalizeDocument(
  source: SourceDefinitionBase,
  meetingStartIso: string,
  agendaItemId: string,
  doc: ParlaeusDocumentRef,
): DocumentEntity {
  const id = canonicalDocumentId(source, doc.dcid);
  const link = cleanParlaeusLink(doc.link);
  const name = doc.title?.trim() || doc.dcid;
  return {
    id,
    type: "Document",
    name,
    classification: doc.type ? ["Document", doc.type] : ["Document"],
    original_url: link,
    identifier_url: link,
    file_name: fileNameFromUrl(link),
    last_discussed_at: meetingStartIso,
    is_referenced_by: agendaItemId,
    organization: canonicalOrganizationId(source),
    source_info: {
      supplier: source.supplier,
      source: source.key,
      organization_type: source.organizationType,
      canonical_id: doc.dcid,
      canonical_iri: link,
      source_iri: link,
    },
    raw: doc,
  };
}

function normalizeAgendaPoint(
  source: SourceDefinitionBase,
  meetingStartIso: string,
  point: ParlaeusAgendaPoint,
  order: number,
): { item: MeetingAgendaItem; documents: DocumentEntity[] } {
  const agendaItemId = canonicalAgendaItemId(source, point.apid);
  const documents = (point.documents ?? [])
    .filter((doc) => doc && doc.dcid)
    .map((doc) => normalizeDocument(source, meetingStartIso, agendaItemId, doc));

  const item: MeetingAgendaItem = {
    id: agendaItemId,
    title: point.title?.trim() || undefined,
    description: point.text?.trim() || undefined,
    number: point.number || undefined,
    order,
    classification: point.type || undefined,
    start_date: meetingStartIso,
    documents: documents.map((document) => ({
      id: document.id,
      name: document.name,
      file_name: document.file_name,
      original_url: document.original_url,
    })),
  };

  return { item, documents };
}

export function normalizeParlaeusAgenda(
  source: SourceDefinitionBase,
  detail: ParlaeusAgendaDetail,
): { meeting: MeetingEntity; documents: DocumentEntity[] } {
  const meetingId = canonicalMeetingId(source, detail.agid);
  const startDate = isoStartDate(detail.date, detail.time);
  const endDate = isoEndDate(detail.date, detail.endtime) ?? startDate;
  const committeeId = detail.cmid ? canonicalCommitteeId(source, detail.cmid) : undefined;

  const allDocuments: DocumentEntity[] = [];
  const agenda: MeetingAgendaItem[] = [];

  (detail.points ?? []).forEach((point, index) => {
    if (!point || !point.apid) {
      return;
    }
    const { item, documents } = normalizeAgendaPoint(source, startDate, point, index + 1);
    agenda.push(item);
    allDocuments.push(...documents);
  });

  const dedup = new Map<string, DocumentEntity>();
  for (const doc of allDocuments) {
    dedup.set(doc.id, doc);
  }

  const meeting: MeetingEntity = {
    id: meetingId,
    type: "Meeting",
    name: detail.title?.trim() || `Vergadering ${detail.committeecode ?? ""}`.trim(),
    classification: ["Agenda"],
    description: detail.description?.trim() || undefined,
    location: detail.location?.trim() || undefined,
    start_date: startDate,
    end_date: endDate,
    last_discussed_at: startDate,
    organization: canonicalOrganizationId(source),
    committee: committeeId,
    status: detail.cancelled && detail.cancelled !== 0 ? "cancelled" : "confirmed",
    agenda,
    attachment: [...dedup.values()].map((doc) => doc.id),
    source_info: {
      supplier: source.supplier,
      source: source.key,
      organization_type: source.organizationType,
      canonical_id: detail.agid,
    },
    raw: detail,
  };

  return { meeting, documents: [...dedup.values()] };
}
