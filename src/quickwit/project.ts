import type {
  CommitteeEntity,
  DocumentEntity,
  EntityCommitEvent,
  MeetingEntity,
  MotionEntity,
  PartyEntity,
  PersonEntity,
  WooziEntity,
} from "../types.ts";
import { currentProjectionVersion } from "../pipeline/versioning.ts";

export interface QuickwitSearchDocument {
  time: string;
  event_id: string;
  event_type: string;
  source: string;
  subject: string;
  entity_id: string;
  entity_type: string;
  commit_id: string;
  op: string;
  mode: string;
  schema_name: string;
  schema_version: string;
  content_hash: string;
  supplier?: string;
  source_key?: string;
  document_month?: string;
  name?: string;
  classification?: string[];
  file_name?: string;
  start_date?: string;
  end_date?: string;
  organization?: string;
  committee?: string;
  content?: string;
  parent_entity_id?: string;
  page_number?: number;
  projection_version: string;
  payload: unknown;
}

function documentReferenceDate(payload?: DocumentEntity): string | undefined {
  return payload?.last_discussed_at ?? payload?.date_modified;
}

function toDocumentMonth(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }

  const year = parsed.getUTCFullYear();
  const month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function flattenAgendaContent(items?: MeetingEntity["agenda"]): string[] {
  if (!items?.length) {
    return [];
  }

  const content: string[] = [];
  for (const item of items) {
    if (item.number) {
      content.push(item.number);
    }
    if (item.title) {
      content.push(item.title);
    }
    if (item.description) {
      content.push(item.description);
    }
    for (const document of item.documents ?? []) {
      content.push(document.name);
    }
    content.push(...flattenAgendaContent(item.agenda_items));
  }
  return content;
}

function projectMeetingContent(payload?: MeetingEntity): string | undefined {
  const content = [
    payload?.name,
    ...(payload?.classification ?? []),
    payload?.location,
    ...flattenAgendaContent(payload?.agenda),
  ]
    .filter(Boolean)
    .join(" ");

  return content || undefined;
}

function projectDocumentContent(payload?: DocumentEntity): string | undefined {
  const hasPageChunks = Boolean(payload?.page_chunks && payload.page_chunks.length > 0);
  const content = [
    payload?.name,
    ...(payload?.classification ?? []),
    payload?.file_name,
    ...(hasPageChunks ? [] : (payload?.md_text ?? [])),
  ]
    .filter(Boolean)
    .join(" ");

  return content || undefined;
}

function projectMotionContent(payload?: MotionEntity): string | undefined {
  if (!payload) {
    return undefined;
  }

  // Party names come from both the submitters and the vote breakdown, so a
  // search for a fractie finds the motions it voted on, not just the ones it
  // submitted.
  const voteGroups = payload.votes?.map((vote) => vote.group_name) ?? [];
  const content = [
    payload.name,
    ...(payload.classification ?? []),
    payload.motion_type,
    payload.status,
    payload.result,
    payload.description,
    ...(payload.proposers ?? []),
    ...(payload.co_proposers ?? []),
    ...(payload.parties ?? []),
    ...new Set(voteGroups),
    payload.vote_summary,
    payload.agenda_item_hint,
  ]
    .filter(Boolean)
    .join(" ");

  return content || undefined;
}

function projectGenericEntityContent(
  payload?: CommitteeEntity | PartyEntity | PersonEntity,
): string | undefined {
  if (!payload) {
    return undefined;
  }

  const content = [
    payload.name,
    ...((payload as { classification?: string[] }).classification ?? []),
    (payload as { description?: string }).description,
  ]
    .filter(Boolean)
    .join(" ");

  return content || undefined;
}

export function compactEntityPayload(payload?: WooziEntity): unknown {
  if (!payload) {
    return undefined;
  }

  if (payload.type === "Document") {
    return {
      type: payload.type,
      name: payload.name,
      classification: payload.classification,
      original_url: payload.original_url,
      file_name: payload.file_name,
      content_type: payload.content_type,
      date_modified: payload.date_modified,
      last_discussed_at: payload.last_discussed_at,
      is_referenced_by: payload.is_referenced_by,
      organization: payload.organization,
      derived_content: payload.derived_content,
      media_urls: payload.media_urls,
    };
  }

  if (payload.type === "Person") {
    return {
      type: payload.type,
      name: payload.name,
      classification: payload.classification,
      gender: payload.gender,
      member_of: payload.member_of,
      organization: payload.organization,
      party: payload.party,
    };
  }

  if (payload.type === "Party") {
    return {
      type: payload.type,
      name: payload.name,
      classification: payload.classification,
      subOrganizationOf: payload.subOrganizationOf,
    };
  }

  if (payload.type === "Committee") {
    return {
      type: payload.type,
      name: payload.name,
      classification: payload.classification,
      description: payload.description,
      subOrganizationOf: payload.subOrganizationOf,
      homepage: payload.homepage,
      email: payload.email,
    };
  }

  if (payload.type === "Motion") {
    return {
      type: payload.type,
      name: payload.name,
      classification: payload.classification,
      motion_type: payload.motion_type,
      status: payload.status,
      result: payload.result,
      date: payload.date,
      proposers: payload.proposers,
      co_proposers: payload.co_proposers,
      parties: payload.parties,
      votes: payload.votes,
      tally: payload.tally,
      vote_summary: payload.vote_summary,
      meeting: payload.meeting,
      agenda_item: payload.agenda_item,
      agenda_item_hint: payload.agenda_item_hint,
      attachment: payload.attachment,
      organization: payload.organization,
      last_discussed_at: payload.last_discussed_at,
    };
  }

  return {
    type: payload.type,
    name: payload.name,
    classification: payload.classification,
    status: payload.status,
    location: payload.location,
    start_date: payload.start_date,
    end_date: payload.end_date,
    last_discussed_at: payload.last_discussed_at,
    organization: payload.organization,
    committee: payload.committee,
    parent: payload.parent,
    agenda: payload.agenda,
    attachment: payload.attachment,
  };
}

function projectDocumentPageDocuments(
  event: EntityCommitEvent<WooziEntity>,
  payload: DocumentEntity,
): QuickwitSearchDocument[] {
  const projectionVersion = currentProjectionVersion();
  return (payload.page_chunks ?? []).map((page) => ({
    time: event.time,
    event_id: `${event.id}#page=${page.page_number}`,
    event_type: event.type,
    source: event.source,
    subject: `${event.subject}#page=${page.page_number}`,
    entity_id: `${event.data.entity_id}#page=${page.page_number}`,
    entity_type: "DocumentPage",
    commit_id: event.data.commit_id,
    op: event.data.op,
    mode: event.data.mode,
    schema_name: event.data.schema_name,
    schema_version: event.data.schema_version,
    content_hash: event.data.content_hash,
    supplier: event.data.source.supplier,
    source_key: event.data.source.source,
    document_month: toDocumentMonth(documentReferenceDate(payload)),
    name: payload.name,
    classification: payload.classification,
    file_name: payload.file_name,
    start_date: payload.last_discussed_at,
    organization: payload.organization,
    content: page.markdown,
    parent_entity_id: event.data.entity_id,
    page_number: page.page_number,
    projection_version: projectionVersion,
    payload: compactEntityPayload(payload),
  }));
}

export function projectEntityCommitToQuickwitDocuments(
  event: EntityCommitEvent<WooziEntity>,
): QuickwitSearchDocument[] {
  const payload = event.data.payload;
  const projectionVersion = currentProjectionVersion();
  const content =
    payload?.type === "Document"
      ? projectDocumentContent(payload)
      : payload?.type === "Meeting"
        ? projectMeetingContent(payload)
        : payload?.type === "Motion"
          ? projectMotionContent(payload)
          : projectGenericEntityContent(payload);

  const primaryDocument: QuickwitSearchDocument = {
    time: event.time,
    event_id: event.id,
    event_type: event.type,
    source: event.source,
    subject: event.subject,
    entity_id: event.data.entity_id,
    entity_type: event.data.entity_type,
    commit_id: event.data.commit_id,
    op: event.data.op,
    mode: event.data.mode,
    schema_name: event.data.schema_name,
    schema_version: event.data.schema_version,
    content_hash: event.data.content_hash,
    supplier: event.data.source.supplier,
    source_key: event.data.source.source,
    document_month:
      payload?.type === "Document" ? toDocumentMonth(documentReferenceDate(payload)) : undefined,
    name: payload?.name,
    classification: (payload as { classification?: string[] } | undefined)?.classification,
    file_name: payload?.type === "Document" ? payload.file_name : undefined,
    start_date:
      payload?.type === "Meeting"
        ? payload.start_date
        : payload?.type === "Document"
          ? documentReferenceDate(payload)
          : payload?.type === "Motion"
            ? (payload.last_discussed_at ?? payload.date)
            : undefined,
    end_date: payload?.type === "Meeting" ? payload.end_date : undefined,
    organization: (payload as { organization?: string } | undefined)?.organization,
    committee: payload?.type === "Meeting" ? payload.committee : undefined,
    // Motions hang off the meeting they were decided in, the same way document
    // pages hang off their document, so the meeting view can fetch them.
    parent_entity_id: payload?.type === "Motion" ? payload.meeting : undefined,
    content,
    projection_version: projectionVersion,
    payload: compactEntityPayload(payload),
  };

  if (payload?.type === "Document" && payload.page_chunks?.length) {
    return [primaryDocument, ...projectDocumentPageDocuments(event, payload)];
  }

  return [primaryDocument];
}
