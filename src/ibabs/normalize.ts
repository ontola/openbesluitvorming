import {
  canonicalAgendaItemId,
  canonicalCommitteeId,
  canonicalDocumentId,
  canonicalMeetingId,
  canonicalMotionId,
  canonicalOrganizationId,
  canonicalPartyId,
  canonicalPersonId,
} from "../ids.ts";
import {
  findAgendaItemId,
  type MeetingIndex,
  normalizeMotionResult,
  parseAgendaPointReference,
  parseMotionDate,
  partyFromProposer,
  splitProposers,
  tallyVotes,
} from "../motions/normalize.ts";
import type {
  DocumentEntity,
  IbabsList,
  IbabsListEntryBase,
  IbabsListEntryDetail,
  IbabsListEntryVote,
  IbabsMeeting,
  IbabsMeetingItem,
  IbabsSourceDefinition,
  MeetingAgendaDocumentLink,
  MeetingAgendaItem,
  MeetingEntity,
  MotionEntity,
  MotionVote,
} from "../types.ts";
import { supplierDateTimeToUtc } from "../util/local_time.ts";

function normalizeDateTime(value?: string): string | undefined {
  return supplierDateTimeToUtc(value);
}

/** Compose the end of a meeting from its *local* calendar day and `EndTime`.
 *
 * The day has to come from the raw MeetingDate rather than the normalised
 * start: once the start is a UTC instant its date part can be the previous
 * day, and an evening meeting would then end 24 hours before it began.
 */
function composeEndDate(
  rawMeetingDate?: string,
  endTime?: string,
  normalizedStart?: string,
): string | undefined {
  if (!rawMeetingDate || !endTime) {
    return normalizedStart;
  }

  const [localDay] = rawMeetingDate.trim().split(/[T ]/);
  if (!localDay) {
    return normalizedStart;
  }

  const normalizedTime = endTime.length === 5 ? `${endTime}:00` : endTime;
  return supplierDateTimeToUtc(`${localDay}T${normalizedTime}`) ?? normalizedStart;
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

function collectAgendaItems(
  source: IbabsSourceDefinition,
  meeting: IbabsMeeting,
): MeetingAgendaItem[] {
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
    end_date: composeEndDate(meeting.MeetingDate, meeting.EndTime, startDate),
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

/** Look up a list-entry value by any of several spellings.
 *
 * The `Values` keys come from a per-municipality list template, so the same
 * field appears as "Indiener(s)", "Indieners" or "Indiener" depending on the
 * site. Matching is case-insensitive and ignores surrounding whitespace. */
function pickValue(values: Record<string, string>, names: string[]): string | undefined {
  for (const name of names) {
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(values)) {
      if (key.trim().toLowerCase() === wanted && value.trim().length > 0) {
        return value.trim();
      }
    }
  }
  return undefined;
}

function motionVotes(source: IbabsSourceDefinition, votes: IbabsListEntryVote[]): MotionVote[] {
  return votes
    .filter((vote) => vote.Vote !== undefined)
    .map((vote) => ({
      option: vote.Vote ? ("voor" as const) : ("tegen" as const),
      voter: vote.UserId ? canonicalPersonId(source, vote.UserId) : undefined,
      voter_name: vote.UserName,
      group: vote.GroupId ? canonicalPartyId(source, vote.GroupId) : undefined,
      group_name: vote.GroupName,
    }));
}

export function normalizeIbabsMotion(
  source: IbabsSourceDefinition,
  list: IbabsList,
  entry: IbabsListEntryBase,
  detail: IbabsListEntryDetail,
  votes: IbabsListEntryVote[],
  meetings?: MeetingIndex,
): MotionEntity {
  const values = detail.Values;
  const name =
    pickValue(values, ["Onderwerp", "Titel", "Toezegging"]) ??
    entry.EntryTitle ??
    `${list.ListName} ${entry.EntryId}`;
  const status = pickValue(values, ["Status"]);
  const date = parseMotionDate(pickValue(values, ["Datum", "Datum motie", "Datum indiening"]));

  const proposers = splitProposers(pickValue(values, ["Indiener(s)", "Indieners", "Indiener"]));
  const coProposers = splitProposers(
    pickValue(values, ["Mede-indieners", "Mede-indiener(s)", "Medeondertekenaars"]),
  );
  const parties = [
    ...new Set(
      [...proposers, ...coProposers]
        .map((proposer) => partyFromProposer(proposer))
        .filter((party): party is string => Boolean(party)),
    ),
  ];

  const reference = parseAgendaPointReference(pickValue(values, ["Agendapunt"]));
  const meeting = reference && meetings ? meetings.find(reference) : undefined;
  const agendaItemId = meeting && reference ? findAgendaItemId(meeting, reference) : undefined;
  const normalizedVotes = motionVotes(source, votes);

  return {
    id: canonicalMotionId(source, entry.EntryId),
    type: "Motion",
    name,
    classification: [list.ListName],
    motion_type: list.ListName,
    status,
    result: normalizeMotionResult(status),
    date,
    description: pickValue(values, ["Toelichting", "Stand van zaken openbaar", "Beleidsveld"]),
    proposers: proposers.length > 0 ? proposers : undefined,
    co_proposers: coProposers.length > 0 ? coProposers : undefined,
    parties: parties.length > 0 ? parties : undefined,
    votes: normalizedVotes.length > 0 ? normalizedVotes : undefined,
    tally: tallyVotes(normalizedVotes),
    meeting: meeting?.id,
    agenda_item: agendaItemId,
    // Keep the raw reference when we couldn't resolve it: the meeting may
    // simply fall outside this run's window, and the string still tells a
    // reader which meeting the motion belongs to.
    agenda_item_hint: meeting && agendaItemId ? undefined : pickValue(values, ["Agendapunt"]),
    attachment: detail.Documents.map((document) => canonicalDocumentId(source, document.Id)),
    organization: canonicalOrganizationId(source),
    last_discussed_at: meeting?.start_date ?? date,
    source_info: {
      supplier: source.supplier,
      source: source.key,
      organization_type: source.organizationType,
      canonical_id: entry.EntryId,
      canonical_iri: `ibabs://${source.ibabsSitename}/listentry/${entry.EntryId}`,
    },
    raw: { list, entry, values, documents: detail.Documents, votes },
  };
}

/** Documents attached to a motion, so the motion PDF itself becomes
 * searchable. Ids are derived the same way as meeting documents, so a file
 * that hangs off both an agenda item and a motion stays one entity. */
export function normalizeIbabsMotionDocuments(
  source: IbabsSourceDefinition,
  motion: MotionEntity,
  detail: IbabsListEntryDetail,
): DocumentEntity[] {
  return detail.Documents.map((document) => ({
    id: canonicalDocumentId(source, document.Id),
    type: "Document",
    name: documentName(document),
    classification: [motion.motion_type ?? "Motie"],
    original_url: document.PublicDownloadURL,
    identifier_url: `ibabs://${source.ibabsSitename}/document/${document.Id}`,
    file_name: document.FileName,
    size_in_bytes: document.FileSize,
    last_discussed_at: motion.last_discussed_at,
    is_referenced_by: motion.id,
    organization: motion.organization,
    source_info: {
      supplier: source.supplier,
      source: source.key,
      organization_type: source.organizationType,
      canonical_id: document.Id,
      canonical_iri: `ibabs://${source.ibabsSitename}/document/${document.Id}`,
      source_iri: motion.source_info.canonical_iri,
    },
    raw: document,
  }));
}

/** Documents of a register entry: ingekomen stukken, raadsvragen,
 * toezeggingen, brieven aan de raad, and whatever other list an organisation
 * keeps besides its meetings.
 *
 * ORI harvested these as `Report` entities with their attachments; 117,746 of
 * them across all iBabs sources (#226), most of them dated 2025 and 2026. The
 * entry itself is not projected here -- its attachments are, as Documents
 * classified by the list's name, referenced by the meeting the entry's
 * "Agendapunt" resolves to and by the organisation otherwise. A file that
 * also hangs off an agenda item keeps its id and stays one entity. */
export function normalizeIbabsRegisterDocuments(
  source: IbabsSourceDefinition,
  list: IbabsList,
  entry: IbabsListEntryBase,
  detail: IbabsListEntryDetail,
  meetings?: MeetingIndex,
): DocumentEntity[] {
  const values = detail.Values;
  const title =
    pickValue(values, ["Onderwerp", "Titel", "Toezegging", "Vraag"]) ??
    entry.EntryTitle ??
    `${list.ListName} ${entry.EntryId}`;
  const date =
    parseMotionDate(
      pickValue(values, ["Datum", "Datum ontvangst", "Datum indiening", "Datum toezegging"]),
    ) ?? parseMotionDate(entry.MutationDate);
  const reference = parseAgendaPointReference(pickValue(values, ["Agendapunt"]));
  const meeting = reference && meetings ? meetings.find(reference) : undefined;
  const sourceIri = `ibabs://${source.ibabsSitename}/listentry/${entry.EntryId}`;

  return detail.Documents.map((document) => ({
    id: canonicalDocumentId(source, document.Id),
    type: "Document",
    name: document.DisplayName?.trim() || document.FileName?.trim() || title,
    classification: [list.ListName],
    original_url: document.PublicDownloadURL,
    identifier_url: `ibabs://${source.ibabsSitename}/document/${document.Id}`,
    file_name: document.FileName,
    size_in_bytes: document.FileSize,
    last_discussed_at: meeting?.start_date ?? date,
    is_referenced_by: meeting?.id ?? canonicalOrganizationId(source),
    organization: canonicalOrganizationId(source),
    source_info: {
      supplier: source.supplier,
      source: source.key,
      organization_type: source.organizationType,
      canonical_id: document.Id,
      canonical_iri: `ibabs://${source.ibabsSitename}/document/${document.Id}`,
      source_iri: sourceIri,
    },
    raw: document,
  }));
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
