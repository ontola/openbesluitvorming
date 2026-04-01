export interface SourceInfo {
  supplier: string;
  source: string;
  organization_type?: string;
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

export interface DocumentDerivedContent {
  markdown_key?: string;
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
  md_text?: string[];
  derived_content?: DocumentDerivedContent;
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
  details?: string;
}

export type OrganizationType = "gemeente" | "provincie" | "waterschap";
export type Supplier = "notubiz" | "ibabs" | "gemeenteoplossingen" | "parlaeus";

export interface SourceDefinitionBase {
  key: string;
  label?: string;
  supplier: Supplier;
  organizationType: OrganizationType;
  allmanakId: number;
  cbsId?: string;
}

export interface NotubizSourceDefinition extends SourceDefinitionBase {
  supplier: "notubiz";
  notubizOrganizationId: number;
}

export interface NotubizOrganizationAttributes {
  attributes: Record<string, string>;
}

export interface IbabsSourceDefinition extends SourceDefinitionBase {
  supplier: "ibabs";
  ibabsSitename: string;
}

export type SourceDefinition = NotubizSourceDefinition | IbabsSourceDefinition;

export interface SourceCatalogEntry extends SourceDefinitionBase {
  sourceRef: string;
  sourceName?: string;
  legacyConfigFile: string;
  legacyConfigRoot: string;
  implemented: boolean;
  notubizOrganizationId?: number;
  ibabsSitename?: string;
  baseUrl?: string;
  sessionId?: string;
}

export interface IbabsMeetingType {
  Id: string;
  Description?: string;
  Meetingtype?: string;
}

export interface IbabsUserBasic {
  UniqueId: string;
  Name?: string;
  Emailaddress?: string;
}

export interface IbabsDocument {
  Id: string;
  FileName?: string;
  DisplayName?: string;
  Confidential?: boolean;
  PublicDownloadURL?: string;
  FileSize?: number;
}

export interface IbabsMeetingItem {
  Id: string;
  Features?: string;
  Title?: string;
  Explanation?: string;
  Confidential?: boolean;
  Documents?: IbabsDocument[];
}

export interface IbabsMeeting {
  Id: string;
  MeetingtypeId?: string;
  Meetingtype?: string;
  MeetingDate?: string;
  StartTime?: string;
  EndTime?: string;
  Location?: string;
  Chairman?: string;
  Explanation?: string;
  PublishDate?: string;
  Invitees?: IbabsUserBasic[];
  Attendees?: IbabsUserBasic[];
  MeetingItems?: IbabsMeetingItem[];
  Documents?: IbabsDocument[];
}

export type IngestRunTrigger = "user" | "scheduled" | "manual" | "api";

export interface IngestRunRecord {
  id: string;
  source_key: string;
  supplier: string;
  date_from: string;
  date_to: string;
  trigger: IngestRunTrigger;
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
  details?: string;
  created_at: string;
}

export interface AdminSourceOption {
  key: string;
  sourceRef: string;
  label: string;
  supplier: string;
  organizationType: string;
  implemented: boolean;
  isAggregate?: boolean;
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
  sourceKey?: string;
  sourceRef?: string;
  dateFrom: string;
  dateTo: string;
}

export interface AdminRerunResponse {
  runs: IngestRunRecord[];
}

export interface SearchResult {
  entityId: string;
  entityType: string;
  entityTypeLabel: string;
  organization: string;
  date: string;
  title: string;
  summary: string;
  summaryHtml?: string;
  sortDate?: string;
  downloadUrl?: string;
}

export interface SearchResponse {
  results: SearchResult[];
}

export interface EntityContentResponse {
  entityId: string;
  entityType: string;
  markdownText?: string;
  downloadUrl?: string;
  contentType?: string;
  pdfUrl?: string;
}
