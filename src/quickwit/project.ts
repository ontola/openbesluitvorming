import type { DocumentEntity, EntityCommitEvent, MeetingEntity, WooziEntity } from "../types.ts";

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
  payload: unknown;
}

function projectMeetingContent(payload?: MeetingEntity): string | undefined {
  const content = [payload?.name, ...(payload?.classification ?? []), payload?.location]
    .filter(Boolean)
    .join(" ");

  return content || undefined;
}

function projectDocumentContent(payload?: DocumentEntity): string | undefined {
  const content = [
    payload?.name,
    ...(payload?.classification ?? []),
    payload?.file_name,
    ...(payload?.md_text ?? []),
  ]
    .filter(Boolean)
    .join(" ");

  return content || undefined;
}

export function projectEntityCommitToQuickwitDocument(
  event: EntityCommitEvent<WooziEntity>,
): QuickwitSearchDocument {
  const payload = event.data.payload;
  const content =
    payload?.type === "Document" ? projectDocumentContent(payload) : projectMeetingContent(payload);

  return {
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
    payload,
  };
}
