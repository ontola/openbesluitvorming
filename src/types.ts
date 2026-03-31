export interface SourceInfo {
  supplier: string;
  source: string;
  canonical_id?: string;
  canonical_iri?: string;
  source_iri?: string;
}

export interface EntityCommitData<TPayload> {
  entity_type: string;
  entity_id: string;
  commit_id: string;
  parent_commit_id?: string;
  op: "upsert" | "delete";
  mode: "replace" | "merge";
  schema_name: string;
  schema_version: string;
  content_hash: string;
  source: SourceInfo;
  payload?: TPayload;
}

export interface EntityCommitEvent<TPayload> {
  specversion: "1.0";
  type: "entity.commit";
  source: string;
  id: string;
  time: string;
  subject: string;
  datacontenttype: "application/json";
  data: EntityCommitData<TPayload>;
}

export interface MeetingEntity {
  id: string;
  type: "Meeting";
  name: string;
  classification: string[];
  status?: string;
  description?: string;
  location?: string;
  start_date: string;
  end_date?: string;
  last_discussed_at?: string;
  organization?: string;
  committee?: string;
  parent?: string;
  agenda?: string[];
  attachment?: string[];
  source_info: SourceInfo;
  raw: unknown;
}

export type WooziEntity = MeetingEntity;

export interface NotubizSourceDefinition {
  key: string;
  supplier: "notubiz";
  notubizOrganizationId: number;
  allmanakId: number;
}

export interface NotubizOrganizationAttributes {
  attributes: Record<string, string>;
}
