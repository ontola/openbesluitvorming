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

export interface DocumentMediaLink {
  url: string;
  original_url?: string;
  content_type?: string;
}

export interface DocumentEntity {
  id: string;
  type: "Document";
  name: string;
  classification?: string[];
  original_url?: string;
  identifier_url?: string;
  file_name?: string;
  content_type?: string;
  size_in_bytes?: number;
  date_modified?: string;
  last_discussed_at?: string;
  is_referenced_by?: string;
  creator?: string;
  organization?: string;
  text?: string[];
  md_text?: string[];
  media_urls?: DocumentMediaLink[];
  source_info: SourceInfo;
  raw: unknown;
}

export type WooziEntity = MeetingEntity | DocumentEntity;

export interface ExtractionBundle {
  meetings: MeetingEntity[];
  documents: DocumentEntity[];
  stats: ExtractionStats;
  issues: ExtractionIssue[];
}

export interface ExtractionStats {
  meeting_count: number;
  document_count: number;
  cache_hits: number;
  downloaded_count: number;
  issue_count: number;
}

export interface ExtractionIssue {
  severity: "warning" | "error";
  step:
    | "list_events"
    | "get_meeting"
    | "download_document"
    | "extract_text"
    | "upload_s3"
    | "ingest_quickwit";
  entity_id?: string;
  message: string;
}

export interface NotubizSourceDefinition {
  key: string;
  supplier: "notubiz";
  notubizOrganizationId: number;
  allmanakId: number;
}

export interface NotubizOrganizationAttributes {
  attributes: Record<string, string>;
}

export interface IngestRunRecord {
  id: string;
  source_key: string;
  supplier: string;
  date_from: string;
  date_to: string;
  trigger: "manual" | "api";
  status: "running" | "succeeded" | "partial" | "failed";
  started_at: string;
  finished_at?: string;
  meeting_count: number;
  document_count: number;
  cache_hits: number;
  downloaded_count: number;
  issue_count: number;
  quickwit_index_id?: string;
  error_message?: string;
}

export interface IngestRunIssueRecord {
  id: string;
  run_id: string;
  severity: ExtractionIssue["severity"];
  step: ExtractionIssue["step"];
  entity_id?: string;
  message: string;
  created_at: string;
}

export interface AdminSourceOption {
  key: string;
  label: string;
}

export interface AdminRunsResponse {
  runs: IngestRunRecord[];
}

export interface AdminRunDetailResponse {
  run: IngestRunRecord;
  issues: IngestRunIssueRecord[];
}

export interface AdminSourcesResponse {
  sources: AdminSourceOption[];
}

export interface AdminRerunRequest {
  sourceKey: string;
  dateFrom: string;
  dateTo: string;
}

export interface AdminRerunResponse {
  run: IngestRunRecord;
}

export interface SearchResult {
  entityType: string;
  entityTypeLabel: string;
  organization: string;
  date: string;
  title: string;
  summary: string;
  sortDate?: string;
  fullText: string;
  downloadUrl?: string;
}

export interface SearchResponse {
  results: SearchResult[];
}
