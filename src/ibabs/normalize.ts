import {
  canonicalAgendaItemId,
  canonicalCommitteeId,
  canonicalDocumentId,
  canonicalMeetingId,
  canonicalOrganizationId,
} from "../ids.ts";
import type {
  DocumentEntity,
  IbabsMeeting,
  IbabsMeetingItem,
  IbabsSourceDefinition,
  MeetingAgendaDocumentLink,
  MeetingAgendaItem,
  MeetingEntity,
} from "../types.ts";

function normalizeDateTime(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  return normalized.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(normalized)
    ? normalized
    : `${normalized}Z`;
}

function composeEndDate(startDate?: string, endTime?: string): string | undefined {
  if (!startDate || !endTime) {
    return startDate;
  }

  const [datePart] = startDate.split("T");
  if (!datePart) {
    return startDate;
  }

  const normalizedTime = endTime.length === 5 ? `${endTime}:00` : endTime;
  return `${datePart}T${normalizedTime}Z`;
}

function meetingTypeName(
  source: IbabsSourceDefinition,
  meeting: IbabsMeeting,
  meetingTypes: Map<string, string>,
): string {
  const byTypeId = meeting.MeetingtypeId ? meetingTypes.get(meeting.MeetingtypeId) : undefined;
  return byTypeId ?? meeting.Meetingtype ?? `Vergadering ${meeting.MeetingDate ?? meeting.Id}`;
}

function toAgendaDocumentLinks(
  source: IbabsSourceDefinition,
  item: IbabsMeetingItem,
): MeetingAgendaDocumentLink[] | undefined {
  const documents = (item.Documents ?? []).map((document) => ({
    id: canonicalDocumentId(source, document.Id),
    name: documentName(document),
    file_name: document.FileName,
    original_url: document.PublicDownloadURL,
  }));
  return documents.length > 0 ? documents : undefined;
}

function collectAgendaItems(source: IbabsSourceDefinition, meeting: IbabsMeeting): MeetingAgendaItem[] {
  return (meeting.MeetingItems ?? []).map((item: IbabsMeetingItem, index) => ({
    id: canonicalAgendaItemId(source, item.Id),
    title: item.Title,
    description: item.Explanation,
    order: index + 1,
    documents: toAgendaDocumentLinks(source, item),
  }));
}

function collectAttachmentIds(source: IbabsSourceDefinition, meeting: IbabsMeeting): string[] {
  const ids = new Set<string>();

  for (const document of meeting.Documents ?? []) {
    ids.add(canonicalDocumentId(source, document.Id));
  }
  for (const item of meeting.MeetingItems ?? []) {
    for (const document of item.Documents ?? []) {
      ids.add(canonicalDocumentId(source, document.Id));
    }
  }

  return [...ids];
}

function documentName(document: { DisplayName?: string; FileName?: string; Id: string }): string {
  return document.DisplayName?.trim() || document.FileName?.trim() || `Document ${document.Id}`;
}

function looksLikeCommittee(name: string): boolean {
  return name.toLowerCase().includes("commissie");
}

export function normalizeIbabsMeeting(
  source: IbabsSourceDefinition,
  meeting: IbabsMeeting,
  meetingTypes: Map<string, string>,
): MeetingEntity {
  const meetingType = meetingTypeName(source, meeting, meetingTypes);
  const startDate = normalizeDateTime(meeting.MeetingDate);
  if (!startDate) {
    throw new Error(`Meeting ${meeting.Id} has no meeting date`);
  }

  return {
    id: canonicalMeetingId(source, meeting.Id),
    type: "Meeting",
    name: meetingType,
    classification: ["Agenda"],
    description: meeting.Explanation,
    location: meeting.Location,
    start_date: startDate,
    end_date: composeEndDate(startDate, meeting.EndTime),
    last_discussed_at: startDate,
    organization: canonicalOrganizationId(source),
    committee:
      meeting.MeetingtypeId && looksLikeCommittee(meetingType)
        ? canonicalCommitteeId(source, meeting.MeetingtypeId)
        : undefined,
    agenda: collectAgendaItems(source, meeting),
    attachment: collectAttachmentIds(source, meeting),
    source_info: {
      supplier: source.supplier,
      source: source.key,
      organization_type: source.organizationType,
      canonical_id: meeting.Id,
      canonical_iri: `ibabs://${source.ibabsSitename}/meeting/${meeting.Id}`,
    },
    raw: meeting,
  };
}

export function normalizeIbabsDocuments(
  source: IbabsSourceDefinition,
  meeting: MeetingEntity,
): DocumentEntity[] {
  if (!meeting.raw || typeof meeting.raw !== "object") {
    return [];
  }

  const rawMeeting = meeting.raw as IbabsMeeting;
  const byId = new Map<
    string,
    {
      Id: string;
      FileName?: string;
      DisplayName?: string;
      PublicDownloadURL?: string;
      FileSize?: number;
    }
  >();

  for (const document of rawMeeting.Documents ?? []) {
    byId.set(document.Id, document);
  }
  for (const item of rawMeeting.MeetingItems ?? []) {
    for (const document of item.Documents ?? []) {
      byId.set(document.Id, document);
    }
  }

  return [...byId.values()].map((document) => ({
    id: canonicalDocumentId(source, document.Id),
    type: "Document",
    name: documentName(document),
    classification: ["Bijlage"],
    original_url: document.PublicDownloadURL,
    identifier_url: `ibabs://${source.ibabsSitename}/document/${document.Id}`,
    file_name: document.FileName,
    size_in_bytes: document.FileSize,
    last_discussed_at: meeting.last_discussed_at,
    is_referenced_by: meeting.id,
    organization: meeting.organization,
    source_info: {
      supplier: source.supplier,
      source: source.key,
      organization_type: source.organizationType,
      canonical_id: document.Id,
      canonical_iri: `ibabs://${source.ibabsSitename}/document/${document.Id}`,
      source_iri: meeting.source_info.canonical_iri,
    },
    raw: document,
  }));
}
