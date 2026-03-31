import type { EntityCommitEvent, MeetingEntity } from "../types.ts";

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
  start_date?: string;
  end_date?: string;
  organization?: string;
  committee?: string;
  content?: string;
  payload: unknown;
}

export function projectEntityCommitToQuickwitDocument(
  event: EntityCommitEvent<MeetingEntity>,
): QuickwitSearchDocument {
  const payload = event.data.payload;

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
    start_date: payload?.start_date,
    end_date: payload?.end_date,
    organization: payload?.organization,
    committee: payload?.committee,
    content: [payload?.name, ...(payload?.classification ?? []), payload?.location]
      .filter(Boolean)
      .join(" "),
    payload,
  };
}
