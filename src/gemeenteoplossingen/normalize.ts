import { canonicalAgendaItemId, canonicalCommitteeId, canonicalDocumentId, canonicalMeetingId, canonicalOrganizationId } from "../ids.ts";
import type {
  CommitteeEntity,
  DocumentEntity,
  MeetingAgendaItem,
  MeetingEntity,
  SourceDefinitionBase,
} from "../types.ts";
import type { GoCommittee, GoDocumentRef, GoMeeting, GoMeetingItem } from "./client.ts";

function goSourceInfo(source: SourceDefinitionBase): SourceDefinitionBase["supplier"] {
  return source.supplier;
}

export function normalizeGoCommittee(
  source: SourceDefinitionBase,
  committee: GoCommittee,
): CommitteeEntity {
  const id = canonicalCommitteeId(source, committee.id);
  return {
    id,
    type: "Committee",
    name: committee.name ?? String(committee.id),
    classification: committee.name === "Gemeenteraad" ? ["Council"] : ["Committee"],
    subOrganizationOf: canonicalOrganizationId(source),
    source_info: {
      supplier: goSourceInfo(source),
      source: source.key,
      organization_type: source.organizationType,
      canonical_id: String(committee.id),
    },
    raw: committee,
  };
}

function documentUrlFor(source: SourceDefinitionBase, meetingId: string, documentId: string): string {
  const rawBaseUrl = (source as unknown as { baseUrl?: string }).baseUrl;
  const baseUrl = rawBaseUrl?.trim();
  if (!baseUrl) {
    return "";
  }
  const apiVersion = (source as unknown as { apiVersion?: string }).apiVersion ?? "v1";
  const trimmed = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return `${trimmed}${apiVersion}/meetings/${meetingId}/documents/${documentId}`;
}

function normalizeAgendaItem(
  source: SourceDefinitionBase,
  meetingId: string,
  item: GoMeetingItem,
  meetingStart: string,
): MeetingAgendaItem | null {
  if (!item.sortorder) {
    return null;
  }

  const id = canonicalAgendaItemId(source, item.id);
  const documents = (item.documents ?? [])
    .filter((doc) => doc && doc.id !== undefined)
    .map((doc) => ({
      id: canonicalDocumentId(source, doc.id),
      name: doc.filename ?? String(doc.id),
      file_name: doc.filename,
      original_url: documentUrlFor(source, meetingId, String(doc.id)) || undefined,
    }));

  return {
    id,
    title: item.title,
    description: item.description,
    number: item.number,
    order: item.sortorder,
    start_date: meetingStart,
    documents,
  };
}

function normalizeMeetingDocuments(
  source: SourceDefinitionBase,
  meetingId: string,
  refs: GoDocumentRef[],
  lastDiscussedAt: string | undefined,
): DocumentEntity[] {
  return refs
    .filter((ref) => ref && ref.id !== undefined)
    .map((ref) => {
      const id = canonicalDocumentId(source, ref.id);
      const originalUrl = documentUrlFor(source, meetingId, String(ref.id));
      return {
        id,
        type: "Document",
        name: ref.filename ?? String(ref.id),
        classification: ["Document"],
        original_url: originalUrl || undefined,
        identifier_url: originalUrl || undefined,
        file_name: ref.filename,
        last_discussed_at: lastDiscussedAt,
        is_referenced_by: canonicalMeetingId(source, meetingId),
        organization: canonicalOrganizationId(source),
        source_info: {
          supplier: source.supplier,
          source: source.key,
          organization_type: source.organizationType,
          canonical_id: String(ref.id),
          canonical_iri: originalUrl || undefined,
          source_iri: originalUrl || undefined,
        },
        raw: ref,
      };
    });
}

export function normalizeGoMeeting(source: SourceDefinitionBase, meeting: GoMeeting): MeetingEntity {
  const id = canonicalMeetingId(source, meeting.id);
  const meetingId = String(meeting.id);

  const startDate = meeting.startTime && meeting.startTime.includes(":")
    ? `${meeting.date}T${meeting.startTime}:00`
    : `${meeting.date}T00:00:00`;

  const committeeId = meeting.dmu?.id !== undefined
    ? canonicalCommitteeId(source, meeting.dmu.id)
    : undefined;

  let status = "confirmed";
  if (meeting.canceled) {
    status = "cancelled";
  } else if (meeting.inactive) {
    status = "unconfirmed";
  }

  const agenda = (meeting.items ?? [])
    .map((item) => normalizeAgendaItem(source, meetingId, item, startDate))
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));

  const attachmentIds = (meeting.documents ?? [])
    .filter((doc) => doc && doc.id !== undefined)
    .map((doc) => canonicalDocumentId(source, doc.id));

  return {
    id,
    type: "Meeting",
    name: meeting.description?.trim()
      ? meeting.description.trim()
      : `Vergadering - ${meeting.dmu?.name ?? "onbekend"} - ${startDate}`,
    classification: ["Agenda"],
    description: meeting.description,
    location: meeting.location?.trim() || undefined,
    start_date: startDate,
    end_date: startDate,
    last_discussed_at: startDate,
    organization: canonicalOrganizationId(source),
    committee: committeeId,
    status,
    agenda,
    attachment: attachmentIds,
    source_info: {
      supplier: source.supplier,
      source: source.key,
      organization_type: source.organizationType,
      canonical_id: meetingId,
    },
    raw: meeting,
  };
}

export function normalizeGoDocuments(source: SourceDefinitionBase, meeting: MeetingEntity): DocumentEntity[] {
  const rawMeeting = meeting.raw as GoMeeting;
  const meetingId = String(rawMeeting.id);
  const docs = [
    ...(rawMeeting.documents ?? []),
    ...((rawMeeting.items ?? []).flatMap((item) => item.documents ?? [])),
  ];
  const dedup = new Map<string, GoDocumentRef>();
  for (const doc of docs) {
    if (doc && doc.id !== undefined) {
      dedup.set(String(doc.id), doc);
    }
  }
  return normalizeMeetingDocuments(source, meetingId, [...dedup.values()], meeting.last_discussed_at);
}

