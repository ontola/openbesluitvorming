import type { DocumentEntity, EntityCommitEvent, MeetingEntity, WooziEntity } from "../types.ts";
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

function compactPayload(payload?: WooziEntity): unknown {
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
      organization: payload.organization,
      derived_content: payload.derived_content,
      media_urls: payload.media_urls,
      md_text: payload.md_text,
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
    name: payload.name,
    classification: payload.classification,
    file_name: payload.file_name,
    start_date: payload.last_discussed_at,
    organization: payload.organization,
    content: page.markdown,
    parent_entity_id: event.data.entity_id,
    page_number: page.page_number,
    projection_version: projectionVersion,
    payload: compactPayload(payload),
  }));
}

export function projectEntityCommitToQuickwitDocuments(
  event: EntityCommitEvent<WooziEntity>,
): QuickwitSearchDocument[] {
  const payload = event.data.payload;
  const projectionVersion = currentProjectionVersion();
  const content =
    payload?.type === "Document" ? projectDocumentContent(payload) : projectMeetingContent(payload);

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
    name: payload?.name,
    classification: payload?.classification,
    file_name: payload?.type === "Document" ? payload.file_name : undefined,
    start_date: payload?.type === "Meeting" ? payload.start_date : payload?.last_discussed_at,
    end_date: payload?.type === "Meeting" ? payload.end_date : undefined,
    organization: payload?.organization,
    committee: payload?.type === "Meeting" ? payload.committee : undefined,
    content,
    projection_version: projectionVersion,
    payload: compactPayload(payload),
  };

  if (payload?.type === "Document" && payload.page_chunks?.length) {
    return [primaryDocument, ...projectDocumentPageDocuments(event, payload)];
  }

  return [primaryDocument];
}
