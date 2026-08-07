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
  agenda?: MeetingAgendaItem[];
  attachment?: string[];
  source_info: SourceInfo;
  raw: unknown;
}

export interface MeetingAgendaDocumentLink {
  id: string;
  name: string;
  file_name?: string;
  content_type?: string;
  original_url?: string;
}

export interface MeetingAgendaItem {
  id: string;
  parent?: string;
  title?: string;
  description?: string;
  number?: string;
  order?: number;
  classification?: string;
  is_heading?: boolean;
  start_date?: string;
  end_date?: string;
  documents?: MeetingAgendaDocumentLink[];
  agenda_items?: MeetingAgendaItem[];
}

export interface DocumentMediaLink {
  url: string;
  original_url?: string;
  content_type?: string;
}

export interface DocumentPageChunk {
  page_number: number;
  markdown: string;
}

export interface DocumentDerivedContent {
  markdown_key?: string;
  page_chunks_key?: string;
  page_count?: number;
  extraction_quality_score?: number;
  extraction_quality_status?: "good" | "suspect";
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
  page_chunks?: DocumentPageChunk[];
  derived_content?: DocumentDerivedContent;
  media_urls?: DocumentMediaLink[];
  source_info: SourceInfo;
  raw: unknown;
}

export interface CommitteeEntity {
  id: string;
  type: "Committee";
  name: string;
  classification: string[];
  description?: string;
  subOrganizationOf?: string;
  homepage?: string;
  email?: string;
  source_info: SourceInfo;
  raw: unknown;
}

export interface PartyEntity {
  id: string;
  type: "Party";
  name: string;
  classification: string[];
  subOrganizationOf?: string;
  source_info: SourceInfo;
  raw: unknown;
}

export interface PersonEntity {
  id: string;
  type: "Person";
  name: string;
  classification?: string[];
  gender?: string;
  member_of?: string[];
  organization?: string;
  party?: string;
  source_info: SourceInfo;
  raw: unknown;
}

/** How a single council member voted on a motion.
 *
 * Shaped after `schemas/vote.schema.json` so these can be promoted to
 * first-class Vote entities later, but carried inside the motion rather than
 * emitted separately: a vote is meaningless without its motion, and Utrecht
 * alone would add ~22k standalone index documents per half-year. */
export interface MotionVote {
  option: "voor" | "tegen";
  voter?: string;
  voter_name?: string;
  group?: string;
  group_name?: string;
}

export interface MotionVoteTally {
  in_favour: number;
  against: number;
}

/** A motie, amendement or comparable registry entry with a voting outcome.
 *
 * iBabs calls these "list entries", Notubiz calls them "module items". Both
 * expose an outcome per entry and a link back to the agenda item it was
 * decided in. */
export interface MotionEntity {
  id: string;
  type: "Motion";
  name: string;
  classification: string[];
  /** The supplier's own label, e.g. "Motie", "Amendement", "Motie Vreemd". */
  motion_type?: string;
  /** Supplier status text, verbatim, e.g. "Motie verworpen" or "aangenomen". */
  status?: string;
  /** Normalized outcome derived from `status`. */
  result?: "aangenomen" | "verworpen" | "ingetrokken" | "aangehouden" | "overig";
  date?: string;
  description?: string;
  proposers?: string[];
  co_proposers?: string[];
  parties?: string[];
  /** Per-member breakdown, where the supplier publishes one. */
  votes?: MotionVote[];
  tally?: MotionVoteTally;
  /** Free-text vote breakdown (Notubiz field 61). Stored verbatim — the
   * formatting varies per municipality and misparsing a vote count is worse
   * than showing the original sentence. */
  vote_summary?: string;
  meeting?: string;
  agenda_item?: string;
  /** The raw supplier reference to the agenda item, kept when it could not be
   * resolved to a `meeting`/`agenda_item` id. */
  agenda_item_hint?: string;
  attachment?: string[];
  organization?: string;
  last_discussed_at?: string;
  source_info: SourceInfo;
  raw: unknown;
}

/** One block of spoken text on a recording's timeline.
 *
 * Suppliers publish subtitle cues of 2-4 seconds, which is far too granular to
 * be a useful search unit — a three-hour meeting would be thousands of them.
 * Segments are cues merged into readable blocks, split on a speaker change
 * where we know one. */
export interface RecordingSegment {
  start_seconds: number;
  end_seconds: number;
  text: string;
  /** Canonical person id, where the speaker timeline resolved to someone. */
  speaker?: string;
}

/** An agenda item placed on the recording's timeline. */
export interface RecordingChapter {
  start_seconds: number;
  end_seconds?: number;
  title: string;
  agenda_item?: string;
}

/** A stretch of the recording attributed to one speaker. */
export interface RecordingSpeaker {
  start_seconds: number;
  end_seconds?: number;
  name: string;
  person?: string;
  party?: string;
}

export interface RecordingDerivedContent {
  /** Object storage key of the parsed timeline (segments, chapters, speakers). */
  transcript_key?: string;
  /** Object storage key of the untouched supplier SRT/VTT, kept for the same
   * reason we keep original PDFs: so a better parser later does not mean going
   * back to the supplier. */
  raw_transcript_key?: string;
  segment_count?: number;
  speaker_count?: number;
  chapter_count?: number;
}

/** A video or audio recording of a meeting.
 *
 * We never store the media bytes: one two-day Amsterdam council meeting is
 * 9.8 GB. What we keep is the URL, the timeline, and the spoken text — the
 * transcript is ~30 KB and is the part that makes a meeting searchable on what
 * was said rather than only on what was written down.
 *
 * `segments` is deliberately not part of the commit payload (see
 * `compactEntityPayload`): it goes to object storage, like document markdown,
 * because the payload is stored per search hit. */
export interface RecordingEntity {
  id: string;
  type: "Recording";
  name: string;
  classification?: string[];
  media_type: "video" | "audio";
  /** Canonical meeting id. Projected as `parent_entity_id`, so the meeting
   * view can fetch its recordings the way it already fetches its motions. */
  meeting?: string;
  start_date?: string;
  duration_seconds?: number;
  /** The video platform, which is not the agenda supplier: iBabs meetings are
   * served by Company Webcast. */
  platform?: string;
  /** Stable page to watch on. Use this for user-facing links — `media_url`
   * carries an expiring signature. */
  player_url?: string;
  /** Direct file URL. Recorded for provenance, but not necessarily seekable:
   * Notubiz's `media/download` answers a Range request with a plain 200, so a
   * browser can only play it from the start. */
  media_url?: string;
  /** Adaptive stream (HLS). This is the one that supports seeking, so it is
   * what a timestamp deep-link has to play. */
  stream_url?: string;
  content_type?: string;
  size_in_bytes?: number;
  transcript_language?: string;
  transcript_kind?: "asr" | "corrected";
  /** In-memory only, on its way to object storage. */
  segments?: RecordingSegment[];
  chapters?: RecordingChapter[];
  speakers?: RecordingSpeaker[];
  derived_content?: RecordingDerivedContent;
  organization?: string;
  last_discussed_at?: string;
  source_info: SourceInfo;
  raw: unknown;
}

export type WooziEntity =
  | MeetingEntity
  | DocumentEntity
  | CommitteeEntity
  | PartyEntity
  | PersonEntity
  | MotionEntity
  | RecordingEntity;

/** Everything an extractor can hand to `onEntity`. Shared so every extractor
 * declares the same (widest) callback type — `runExtractor` in `ingest.ts`
 * passes one handler to all of them. */
export type ExtractedEntity =
  | MeetingEntity
  | DocumentEntity
  | CommitteeEntity
  | PartyEntity
  | PersonEntity
  | MotionEntity
  | RecordingEntity;

export interface ExtractionBundle {
  meetings: MeetingEntity[];
  documents: DocumentEntity[];
  committees?: CommitteeEntity[];
  parties?: PartyEntity[];
  persons?: PersonEntity[];
  motions?: MotionEntity[];
  recordings?: RecordingEntity[];
  stats: ExtractionStats;
  issues: ExtractionIssue[];
}

export interface ExtractionStats {
  meeting_count: number;
  document_count: number;
  cache_hits: number;
  downloaded_count: number;
  issue_count: number;
  motion_count?: number;
  recording_count?: number;
}

export interface ExtractionIssue {
  severity: "warning" | "error";
  step:
    | "list_events"
    | "get_meeting"
    | "list_motions"
    | "list_media"
    | "download_transcript"
    | "download_document"
    | "extract_text"
    | "upload_s3"
    | "ingest_quickwit"
    | "export_log_flush"
    | "bsn_quarantine";
  entity_id?: string;
  message: string;
  details?: string;
}

export type OrganizationType = "gemeente" | "provincie" | "waterschap";
export type Supplier = "notubiz" | "ibabs" | "gemeenteoplossingen" | "parlaeus" | "allmanak";

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

/** One media file belonging to a Notubiz meeting.
 *
 * From `GET /media?event_id=<meeting_id>`. `download_url` and `subtitles_url`
 * come back without a scheme (`api.notubiz.nl/…`) and may contain spaces, so
 * they need normalizing before use — see `notubizMediaUrl`. */
export interface NotubizMedia {
  id: number;
  event_id: number;
  media_type: "video" | "audio" | string;
  filename?: string;
  /** SRT filename, or null when the meeting has no transcript. */
  subtitles?: string | null;
  download_url?: string;
  subtitles_url?: string;
  streamer?: string;
  stream_name?: string;
  audio_encoding?: string;
  video_encoding?: string;
  aspect_ratio?: string;
  file_size?: number;
  last_modified?: string;
}

export interface NotubizModule {
  id: number;
  /** Notubiz's own module name, stable across organisations ("Moties"). */
  name: string;
  /** The organisation's rename of it ("Moties en Amendementen"), often empty. */
  custom_name?: string;
}

export interface NotubizModuleItemValue {
  content?: string | number | null;
  meta_data?: {
    reference_model?: string;
    label?: string;
  } | null;
}

export interface NotubizModuleItemAttribute {
  id: number;
  label?: string;
  datatype?: string;
  values?: NotubizModuleItemValue[];
}

export interface NotubizModuleItem {
  id: number;
  module_id?: number;
  organisation_id?: number;
  last_modified?: string;
  attributes?: NotubizModuleItemAttribute[];
  attachments?: {
    document?: unknown[];
  };
}

export interface NotubizOrganizationAttributes {
  attributes: Record<string, string>;
}

export interface IbabsSourceDefinition extends SourceDefinitionBase {
  supplier: "ibabs";
  ibabsSitename: string;
}

export interface GemeenteOplossingenSourceDefinition extends SourceDefinitionBase {
  supplier: "gemeenteoplossingen";
  baseUrl: string;
  apiVersion?: "v1" | "v2";
}

export interface ParlaeusSourceDefinition extends SourceDefinitionBase {
  supplier: "parlaeus";
  baseUrl: string;
  sessionId: string;
}

export type SourceDefinition =
  | NotubizSourceDefinition
  | IbabsSourceDefinition
  | GemeenteOplossingenSourceDefinition
  | ParlaeusSourceDefinition;

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

/** One registry in `GetLists`, e.g. "Moties" or "1.2 Amendementen". */
export interface IbabsList {
  ListId: string;
  ListName: string;
}

export interface IbabsListEntryBase {
  EntryId: string;
  EntryMasterId?: string;
  EntryTitle?: string;
  ListId?: string;
  ListName?: string;
  ListCanVote?: boolean;
  MutationDate?: string;
}

export interface IbabsListEntryDetail {
  EntryId: string;
  /** Per-list-template key/value pairs: Onderwerp, Status, Indiener(s), … */
  Values: Record<string, string>;
  Documents: IbabsDocument[];
}

export interface IbabsListEntryVote {
  EntryId?: string;
  GroupId?: string;
  GroupName?: string;
  UserId?: string;
  UserName?: string;
  Vote?: boolean;
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
  /** The `iBabsWebcast.Code` of this meeting's registration, e.g.
   * "amstelveen/20240131_1". It is a Company Webcast identifier: that platform
   * serves the video, the transcript and the speaker timeline for iBabs
   * sources, reachable from the code alone. Absent when the meeting was not
   * streamed — which is the measurement we still owe: what share of iBabs
   * meetings carry one. */
  WebcastCode?: string;
}

export type IngestRunTrigger = "user" | "scheduled" | "manual" | "api" | "backfill";
export type IngestExecutionMode =
  | "full"
  | "rederive_cached"
  | "reindex_only"
  /** Import only the motion registries, skipping the meeting and document
   * pass. Backfilling motions across every source in `full` mode would redo
   * work already done — waterschap_limburg's ten-year window took 479 minutes,
   * almost all of it meetings and documents we already hold. */
  | "motions_only"
  /** Import only the recordings (media metadata, transcript, timeline),
   * skipping the meeting and document pass. Same reasoning as
   * `motions_only`: the historical media backfill must not re-download
   * documents we already hold. */
  | "media_only"
  | "retry_failed_documents";

export interface IngestRunRecord {
  id: string;
  source_key: string;
  supplier: string;
  date_from: string;
  date_to: string;
  trigger: IngestRunTrigger;
  execution_mode: IngestExecutionMode;
  parent_run_id?: string;
  projection_version?: string;
  derivation_version?: string;
  status: "queued" | "running" | "succeeded" | "partial" | "failed";
  started_at: string;
  finished_at?: string;
  meeting_count: number;
  document_count: number;
  /** Motions imported. Optional because runs predating the motion pass have
   * no value for it, and a missing count must not read as a real zero. */
  motion_count?: number;
  /** Recordings imported. Optional for the same reason as `motion_count`. */
  recording_count?: number;
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
  hasMore?: boolean;
}

export interface AdminRunSummary {
  queuedCount: number;
  runningCount: number;
  succeededCount: number;
  partialCount: number;
  failedCount: number;
  currentRun?: IngestRunRecord;
  oldestQueuedRun?: IngestRunRecord;
}

export interface AdminRunSummaryResponse {
  summary: AdminRunSummary;
}

export interface AdminCoverageCell {
  month: string;
  status?: IngestRunRecord["status"];
  documentCount: number;
  meetingCount: number;
  issueCount: number;
  startedAt?: string;
  runId?: string;
}

export interface AdminCoverageRow {
  sourceKey: string;
  label: string;
  supplier: string;
  organizationType: string;
  months: AdminCoverageCell[];
  totalDocumentCount: number;
  coveredMonthCount: number;
}

export interface AdminCoverageResponse {
  months: string[];
  rows: AdminCoverageRow[];
  maxDocumentCount: number;
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
  executionMode?: IngestExecutionMode;
  parentRunId?: string;
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
  matchedPage?: number;
  pageCount?: number;
  previewImageUrl?: string;
}

export interface SearchResponse {
  results: SearchResult[];
  totalCount?: number;
  totalIsApproximate?: boolean;
  hasMore?: boolean;
}

/** A motion as shown on a meeting page. */
export interface MeetingMotion {
  id: string;
  name: string;
  motion_type?: string;
  status?: string;
  result?: MotionEntity["result"];
  date?: string;
  proposers?: string[];
  co_proposers?: string[];
  parties?: string[];
  votes?: MotionVote[];
  tally?: MotionVoteTally;
  vote_summary?: string;
  agenda_item?: string;
  agenda_item_hint?: string;
}

/** A recording as the meeting detail view needs it: enough to play, to jump to
 * an agenda item, and to read along with what was said. */
export interface MeetingRecording {
  id: string;
  name: string;
  media_type: "video" | "audio";
  /** The seekable stream. Without this the player can only start at zero. */
  stream_url?: string;
  media_url?: string;
  player_url?: string;
  duration_seconds?: number;
  transcript_kind?: RecordingEntity["transcript_kind"];
  chapters?: RecordingChapter[];
  speakers?: RecordingSpeaker[];
  /** Rehydrated from object storage by the detail endpoint, not from the
   * search payload — the transcript is far too big to store per hit. */
  segments?: RecordingSegment[];
}

export interface EntityContentResponse {
  entityId: string;
  entityType: string;
  entityTypeLabel?: string;
  title?: string;
  organization?: string;
  date?: string;
  sortDate?: string;
  markdownText?: string;
  downloadUrl?: string;
  contentType?: string;
  pdfUrl?: string;
  meetingId?: string;
  agenda?: MeetingAgendaItem[];
  /** Motions decided in this meeting, when the entity is a Meeting. */
  motions?: MeetingMotion[];
  /** Video/audio registrations of this meeting, when the entity is a Meeting. */
  recordings?: MeetingRecording[];
  /** The motion itself, when the entity is a Motion. Without this the detail
   * endpoint would answer with a title and a date and silently drop the
   * outcome and the votes — the only reason to look a motion up. */
  motion?: MeetingMotion;
}

/** One line in the per-source export changes log. Compact by design: full
 * markdown/PDF content is reachable via the payload's derived_content and
 * media_urls references, never inlined. */
export interface ExportChangeRecord {
  seq: number;
  op: "upsert" | "delete";
  time: string;
  entity_id: string;
  entity_type: string;
  source_key: string;
  supplier: string;
  commit_id?: string;
  content_hash?: string;
  schema_version?: string;
  payload?: unknown;
}

export interface ExportPage {
  records: ExportChangeRecord[];
  nextCursor: string;
  hasMore: boolean;
}
