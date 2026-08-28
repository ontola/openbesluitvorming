import type {
  CommitteeEntity,
  DocumentEntity,
  EntityCommitEvent,
  MeetingEntity,
  MotionEntity,
  PartyEntity,
  PersonEntity,
  RecordingEntity,
  WooziEntity,
} from "../types.ts";
import { currentProjectionVersion } from "../pipeline/versioning.ts";
import { supplierDateTimeToUtc } from "../util/local_time.ts";

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

/** `start_date` is a mapped `datetime` fast field (it has to be, or search
 * cannot sort or range-filter on the meeting date — see issue #184). Quickwit
 * parses mapped datetime fields strictly and **silently drops the entire
 * document** when the value does not parse: no error, no partial index, the
 * entity simply never appears in search. Verified against 0.8.1 — feeding
 * "onzin", "" and "2024-13-45" reduced the indexed count with a successful
 * ingest response.
 *
 * Suppliers do emit junk here (and motions fall back to a bare `date`), so
 * normalize to RFC3339 and give up to `undefined` rather than pass anything
 * through unchecked. A missing value costs one badly-sorted row — it sorts
 * last in both directions — where an unparseable one costs the whole entity. */
function toIndexDateTime(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  // A reading without a zone is a Dutch wall clock, not UTC.
  //
  // This is where #203 actually lived. The suppliers' own normalisers already
  // convert (`supplierDateTimeToUtc`), but they only run at import time, and
  // the export log faithfully kept what they produced *before* that fix: bare
  // readings like `2023-11-28 19:30:00`. Projection then handed those to
  // `new Date()`, which in a UTC container reads them as 19:30 UTC and stamps
  // `2023-11-28T19:30:00Z` — a council meeting claimed an hour or two late,
  // and near midnight a whole day off, which moves it into the wrong
  // `dateFrom`/`dateTo` window.
  //
  // Doing it here rather than only at import is what makes the backlog
  // repairable: the raw wall clock survives in the export log, so a
  // reindex_only re-projects it correctly without asking a supplier anything.
  const normalized = supplierDateTimeToUtc(trimmed);
  if (normalized) {
    return normalized;
  }

  // Fallback for shapes supplierDateTimeToUtc does not recognise but Date
  // does, e.g. sub-second precision. Kept because the cost of the two
  // outcomes is not symmetric: an unparseable value makes Quickwit drop the
  // whole entity, while a slightly wrong one costs a badly sorted row. A
  // zoneless reading that lands here is still stamped as UTC, but every shape
  // the suppliers are known to emit is handled above.
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }

  // Second precision, matching the shape the suppliers already emit, so the
  // projected value stays comparable to the raw one in fixtures and logs.
  return `${parsed.toISOString().slice(0, 19)}Z`;
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

/** What a recording contributes to search.
 *
 * Phase A of the media slice: the whole transcript goes into `content` as one
 * document, which costs roughly one row per recording. Splitting the
 * transcript into per-segment sub-documents (the `DocumentPage` pattern) would
 * rank snippets more precisely, but at ~90 segments per meeting that is tens of
 * millions of extra rows on an index that already holds 40M document pages.
 * Do that only once measurement shows this is not good enough — and it can be
 * done as a pure projection change, because `derived_content.transcript_key`
 * lets `reindex_only` rehydrate the text from object storage without going back
 * to the supplier. */
function projectRecordingContent(payload?: RecordingEntity): string | undefined {
  if (!payload) {
    return undefined;
  }

  const content = [
    payload.name,
    ...(payload.classification ?? []),
    ...(payload.chapters ?? []).map((chapter) => chapter.title),
    // Speaker names make a recording findable by who was at the microphone,
    // which is the question the transcript alone answers badly: ASR mangles
    // names far more often than the speaker list does.
    ...new Set((payload.speakers ?? []).map((speaker) => speaker.name)),
    ...(payload.segments ?? []).map((segment) => segment.text),
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

  if (payload.type === "Recording") {
    // `segments` is deliberately absent: the transcript lives in object
    // storage, and inlining it here would repeat ~30 KB in every stored hit.
    // `derived_content.transcript_key` is how the detail view finds it.
    return {
      type: payload.type,
      name: payload.name,
      classification: payload.classification,
      media_type: payload.media_type,
      meeting: payload.meeting,
      start_date: payload.start_date,
      duration_seconds: payload.duration_seconds,
      platform: payload.platform,
      player_url: payload.player_url,
      media_url: payload.media_url,
      stream_url: payload.stream_url,
      content_type: payload.content_type,
      size_in_bytes: payload.size_in_bytes,
      transcript_language: payload.transcript_language,
      transcript_kind: payload.transcript_kind,
      chapters: payload.chapters,
      speakers: payload.speakers,
      derived_content: payload.derived_content,
      organization: payload.organization,
      last_discussed_at: payload.last_discussed_at,
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
    start_date: toIndexDateTime(payload.last_discussed_at),
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
          : payload?.type === "Recording"
            ? projectRecordingContent(payload)
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
    start_date: toIndexDateTime(
      payload?.type === "Meeting"
        ? payload.start_date
        : payload?.type === "Document"
          ? documentReferenceDate(payload)
          : payload?.type === "Motion"
            ? (payload.last_discussed_at ?? payload.date)
            : payload?.type === "Recording"
              ? (payload.start_date ?? payload.last_discussed_at)
              : undefined,
    ),
    end_date: payload?.type === "Meeting" ? payload.end_date : undefined,
    organization: (payload as { organization?: string } | undefined)?.organization,
    committee: payload?.type === "Meeting" ? payload.committee : undefined,
    // Motions and recordings hang off the meeting they belong to, the same way
    // document pages hang off their document, so the meeting view can fetch
    // them.
    parent_entity_id:
      payload?.type === "Motion" || payload?.type === "Recording" ? payload.meeting : undefined,
    content,
    projection_version: projectionVersion,
    payload: compactEntityPayload(payload),
  };

  if (payload?.type === "Document" && payload.page_chunks?.length) {
    return [primaryDocument, ...projectDocumentPageDocuments(event, payload)];
  }

  return [primaryDocument];
}
