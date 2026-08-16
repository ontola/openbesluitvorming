import type {
  AdminCoverageCell,
  AdminCoverageResponse,
  AdminCoverageRow,
  EntityContentResponse,
  MeetingAgendaItem,
  MeetingMotion,
  MeetingRecording,
  SearchResponse,
  SearchResult,
} from "../src/types.ts";
import { getConfigValue } from "../src/config.ts";
import { getExportLog } from "../src/exports/log.ts";
import { NotubizClient } from "../src/notubiz/client.ts";
import { normalizeNotubizAgendaItems } from "../src/notubiz/normalize.ts";
import {
  currentProjectionVersion,
  projectionSupportsDateSort,
} from "../src/pipeline/versioning.ts";
import { QuickwitClient } from "../src/quickwit/client.ts";
import { getSource, listSources } from "../src/sources/index.ts";
import { ObjectStorageClient } from "../src/storage/s3.ts";
import { readTranscript } from "../src/recordings/storage.ts";
import { pdfPageCacheKey } from "../src/documents/thumbnails.ts";

type SearchHit = {
  time?: string;
  op?: string;
  entity_id?: string;
  entity_type?: string;
  parent_entity_id?: string;
  page_number?: number;
  projection_version?: string;
  name?: string;
  organization?: string;
  start_date?: string;
  content?: string;
  file_name?: string;
  content_type?: string;
  source_key?: string;
  payload?: {
    original_url?: string;
    media_urls?: Array<{
      url?: string;
      content_type?: string;
      original_url?: string;
    }>;
    derived_content?: {
      markdown_key?: string;
      page_count?: number;
      transcript_key?: string;
    };
    media_type?: "video" | "audio";
    stream_url?: string;
    media_url?: string;
    player_url?: string;
    duration_seconds?: number;
    transcript_kind?: MeetingRecording["transcript_kind"];
    chapters?: MeetingRecording["chapters"];
    speakers?: MeetingRecording["speakers"];
    is_referenced_by?: string;
    agenda?: MeetingAgendaItem[];
    motion_type?: string;
    status?: string;
    result?: MeetingMotion["result"];
    date?: string;
    proposers?: string[];
    co_proposers?: string[];
    parties?: string[];
    votes?: MeetingMotion["votes"];
    tally?: MeetingMotion["tally"];
    vote_summary?: string;
    meeting?: string;
    agenda_item?: string;
    agenda_item_hint?: string;
    attachment?: string[];
  };
};

type SearchSnippet = {
  content?: string[];
  name?: string[];
};

type IndexedHit = {
  hit: SearchHit;
  snippet?: SearchSnippet;
};

type SearchTimingMetric = {
  name: string;
  durationMs: number;
};

type SearchTimingRecorder = (metric: SearchTimingMetric) => void;

/** Rows pulled per Quickwit request while filling a page, and the ceiling on
 * rows scanned for one search.
 *
 * A result is assembled from several index rows: one per page of a PDF, plus
 * one per commit of the entity. Dedup and grouping collapse those into one
 * result, so the scan has to over-fetch to fill a page. Measured on reindexed
 * data: 6.7 page rows per document, which is where the initial estimate comes
 * from -- it is refined per request from what actually comes back.
 *
 * The ceiling is what keeps a broad query from walking the whole index. When it
 * is hit the response says so through `totalIsApproximate` and `hasMore`
 * rather than quietly presenting a truncated set as complete. */
const INITIAL_ROWS_PER_RESULT = 8;
const MIN_SCAN_BATCH_ROWS = 32;
const SCAN_BATCH_ROWS = 500;
const MAX_SCAN_ROWS = 6000;

const PREVIEW_HEAD_TIMEOUT_MS = 300;
const PREVIEW_URL_CACHE_TTL_MS = 10 * 60_000;

type PreviewUrlCacheEntry = {
  expiresAt: number;
  promise: Promise<string | undefined>;
};

const previewUrlCache = new Map<string, PreviewUrlCacheEntry>();

type CoverageBucket = {
  key?: string;
  doc_count?: number;
  by_month?: {
    buckets?: Array<{
      key?: string;
      doc_count?: number;
    }>;
  };
};

function looksLikePdf(options: { contentType?: string; fileName?: string; url?: string }): boolean {
  const contentType = options.contentType?.toLowerCase();
  if (contentType?.includes("application/pdf")) {
    return true;
  }

  const fileName = options.fileName?.toLowerCase();
  if (fileName?.endsWith(".pdf")) {
    return true;
  }

  const url = options.url?.toLowerCase();
  if (!url) {
    return false;
  }

  return url.includes(".pdf") || url.includes("content-type=application/pdf");
}

function cachedPublicPreviewUrl(url: string): Promise<string | undefined> {
  const now = Date.now();
  const cached = previewUrlCache.get(url);
  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }

  const promise = fetch(url, {
    method: "HEAD",
    signal: AbortSignal.timeout(PREVIEW_HEAD_TIMEOUT_MS),
  })
    .then((response) => {
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      return response.ok && contentType.includes("image/jpeg") ? url : undefined;
    })
    .catch(() => undefined);

  previewUrlCache.set(url, {
    expiresAt: now + PREVIEW_URL_CACHE_TTL_MS,
    promise,
  });
  return promise;
}

/** Quote an exact value — an entity id, a source key, our own projection
 * version. These are identifiers matched against `raw`-tokenized fields, where
 * the whole string is a single token and quoting means "this exact value".
 *
 * The backslash has to go first: escaping only the double quote left a
 * trailing `\` free to escape the closing quote we add, which turned the whole
 * query into a syntax error (#197).
 *
 * Not for free text. See buildSearchClause. */
function escapeTerm(term: string): string {
  return `"${term.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** A clause that parses and matches nothing.
 *
 * Needed when a query had content but none of it survived sanitising, e.g.
 * `:::`. Pushing no clause at all would silently widen the search to every
 * document the other filters allow, which reads as "your search matched
 * everything" — the opposite of the truth. */
const MATCHES_NOTHING = "entity_type:__geen_resultaat__";

/** Turn user input into bare terms.
 *
 * This used to wrap each token in quotes, which looks like escaping but is not:
 * quotes make it a *phrase* query. As long as the token was a single word that
 * was harmless, but ordinary punctuation splits it — `14:30`, `kosten/baten`,
 * `a+b` — and a multi-term phrase needs position data. `name` is indexed
 * without positions, so Quickwit answered the whole request with a schema error
 * and the API turned that into a 500 on entirely reasonable input (#197).
 *
 * Bare terms are the fix. Stripping everything that is not a letter or a digit
 * matches how the default tokenizer splits text anyway, so `kosten/baten`
 * becomes `kosten AND baten` and finds what the reader meant. Lowercasing
 * doubles as protection against the query keywords: `AND`, `OR`, `NOT` and `TO`
 * only bind in upper case, so a search for the word "not" stays a word. */
function buildSearchClause(text: string): string {
  const tokens = text
    .toLowerCase()
    // Unicode-aware: Dutch text is full of ë, ï and é, and those are letters.
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (tokens.length === 0) {
    return text.trim() ? MATCHES_NOTHING : "";
  }
  if (tokens.length === 1) {
    return tokens[0];
  }
  return `(${tokens.join(" AND ")})`;
}

function expandDutchGovernanceTerms(query: string): string[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [];
  }

  const terms = new Set([normalized]);
  const words = normalized.split(/\s+/);

  for (const word of words) {
    if (word.endsWith("vergadering") && word !== "vergadering") {
      terms.add("vergadering");
    }
    if (word.endsWith("besluitenlijst") && word !== "besluitenlijst") {
      terms.add("besluitenlijst");
    }
    if (word.endsWith("raadsvergadering")) {
      terms.add("raad");
      terms.add("vergadering");
    }
    if (word.endsWith("commissievergadering")) {
      terms.add("commissie");
      terms.add("vergadering");
    }
  }

  return [...terms];
}

function buildQuickwitQuery(
  query: string,
  organization: string,
  entityType: string,
  dateFrom = "",
  dateTo = "",
): string {
  // Every branch has to name its types explicitly: an unknown entityType falls
  // through to the union, so a type that is missing here is not merely
  // unfilterable — it is invisible in ordinary search too.
  const typeQuery =
    entityType === "Meeting"
      ? "entity_type:Meeting"
      : entityType === "Motion"
        ? "entity_type:Motion"
        : // Recordings only carry text worth matching when there is a transcript,
          // so without a query the type is pointless to list: it would return
          // recordings by date and tell the reader nothing.
          entityType === "Recording"
          ? "entity_type:Recording"
          : entityType === "Document"
            ? query
              ? "(entity_type:Document OR entity_type:DocumentPage)"
              : "entity_type:Document"
            : query
              ? "(entity_type:Meeting OR entity_type:Document OR entity_type:DocumentPage OR entity_type:Motion OR entity_type:Recording)"
              : "(entity_type:Meeting OR entity_type:Document OR entity_type:Motion)";
  const parts = [`projection_version:${escapeTerm(currentProjectionVersion())}`, typeQuery];

  if (organization) {
    // Quoted, not interpolated raw. Unescaped this was a query injection:
    // `organization=soest OR entity_type:Meeting` escaped its own clause and
    // returned meetings from other municipalities. Everything in this index is
    // public, so nothing confidential was reachable, but a caller could still
    // shape an arbitrarily expensive query while the rate limiter charged it a
    // single unit.
    parts.push(`source_key:${escapeTerm(organization)}`);
  }

  if (query) {
    const expandedTerms = expandDutchGovernanceTerms(query);
    if (expandedTerms.length === 1) {
      parts.push(buildSearchClause(expandedTerms[0]));
    } else {
      const clauses = expandedTerms.map(buildSearchClause).filter(Boolean);
      // Every expansion sanitising away would otherwise emit `()`, which is
      // itself a parse error.
      parts.push(clauses.length > 0 ? `(${clauses.join(" OR ")})` : MATCHES_NOTHING);
    }
  }

  // Push the date filter into Quickwit as a real range over start_date, which
  // projection v3 maps as a datetime fast field.
  //
  // This used to enumerate document_month terms instead, because start_date
  // was a dynamic text field and range queries against it were silently
  // ignored (2019 / 2026 / unfiltered all returned the identical 1138409
  // hits). That workaround could only cover Documents: meetings and motions
  // carry no document_month, so they had to be exempted from date filtering
  // altogether and simply never appeared in a date-filtered search.
  //
  // Both restrictions are gone with the mapped field, so the filter applies to
  // every entity type. Entities whose start_date did not parse carry no value
  // and drop out of the range — matching the app-side filter, which also drops
  // rows without a date.
  const rangeClause = startDateRangeClause(dateFrom, dateTo);
  if (rangeClause) {
    parts.push(rangeClause);
  }

  return parts.join(" AND ");
}

/** Quickwit range clause over the mapped `start_date` datetime field, or null
 * when neither bound is usable. `dateTo` is inclusive of the whole day, the
 * same way the app-side filter compares on the date part only. */
export function startDateRangeClause(dateFrom: string, dateTo: string): string | null {
  // Same mapping dependency as the sort. The range was believed to be ignored
  // on an unmapped field, but that belief already cost one outage for sort_by,
  // so it is not trusted for range either. Dropping the pushdown does not drop
  // the filter: filterResultsByDateRange still applies it app-side, which is
  // what happened before v3 anyway.
  if (!projectionSupportsDateSort()) {
    return null;
  }
  const from = dateFrom.trim().slice(0, 10);
  const to = dateTo.trim().slice(0, 10);
  const hasFrom = /^\d{4}-\d{2}-\d{2}$/.test(from);
  const hasTo = /^\d{4}-\d{2}-\d{2}$/.test(to);
  if (!hasFrom && !hasTo) {
    return null;
  }

  const lower = hasFrom ? `${from}T00:00:00Z` : "*";
  const upper = hasTo ? `${to}T23:59:59Z` : "*";
  return `start_date:[${lower} TO ${upper}]`;
}

/** Ordering pushed down to Quickwit, so the scan window holds the newest (or
 * oldest) rows *by meeting date* instead of whatever was ingested last.
 *
 * Note the inverted direction convention: a bare field name sorts descending
 * and a `-` prefix sorts ascending. Verified against 0.8.1, see the client.
 *
 * Title sorting has no fast field to sort on and stays app-side, so it still
 * only orders the fetched window rather than the whole result set. */
export function quickwitSortBy(sort: string): string | undefined {
  // Only an index that maps start_date can sort on it. Against the v2 mapping
  // the field is a dynamic string and Quickwit fails the whole query rather
  // than ignoring the clause — see projectionSupportsDateSort.
  if (!projectionSupportsDateSort()) {
    return undefined;
  }
  if (sort === "date_asc") {
    return "-start_date";
  }
  if (sort === "title_asc") {
    return undefined;
  }
  return "start_date";
}

function entityTypeLabel(entityType?: string): string {
  if (entityType === "Document") {
    return "Document";
  }
  if (entityType === "Meeting") {
    return "Vergadering";
  }
  if (entityType === "Motion") {
    return "Motie";
  }
  if (entityType === "Recording") {
    return "Opname";
  }
  return "Resultaat";
}

/** Rows whose date did not survive projection sort last whichever way the list
 * is ordered, matching how Quickwit orders documents that are missing the sort
 * field. Comparing on `?? ""` instead would drag them to the top of an
 * ascending sort and undo the pushdown's ordering. */
function compareSortDate(left: SearchResult, right: SearchResult, ascending: boolean): number {
  const leftDate = left.sortDate ?? "";
  const rightDate = right.sortDate ?? "";
  if (!leftDate || !rightDate) {
    return leftDate === rightDate ? 0 : leftDate ? -1 : 1;
  }

  return ascending ? leftDate.localeCompare(rightDate) : rightDate.localeCompare(leftDate);
}

function sortResults(results: SearchResult[], sort: string): SearchResult[] {
  const items = [...results];

  if (sort === "date_asc") {
    items.sort((a, b) => compareSortDate(a, b, true));
    return items;
  }

  if (sort === "title_asc") {
    items.sort((a, b) => a.title.localeCompare(b.title, "nl"));
    return items;
  }

  items.sort((a, b) => compareSortDate(a, b, false));
  return items;
}

function filterResultsByDateRange(
  results: SearchResult[],
  options: {
    dateFrom?: string;
    dateTo?: string;
  },
): SearchResult[] {
  const dateFrom = options.dateFrom?.trim();
  const dateTo = options.dateTo?.trim();
  if (!dateFrom && !dateTo) {
    return results;
  }

  return results.filter((result) => {
    const value = result.sortDate?.slice(0, 10);
    if (!value) {
      return false;
    }
    if (dateFrom && value < dateFrom) {
      return false;
    }
    if (dateTo && value > dateTo) {
      return false;
    }
    return true;
  });
}

function summarizeContent(content?: string): string {
  if (!content) {
    return "Geen samenvatting beschikbaar.";
  }

  const compact = content.replaceAll(/\s+/g, " ").trim();
  if (compact.length <= 240) {
    return compact;
  }

  return `${compact.slice(0, 237).trimEnd()}...`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function stripMarkdownPreviewSyntax(value: string): string {
  return value
    .replaceAll(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replaceAll(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replaceAll(/(^|\s)#{1,6}\s+/g, "$1")
    .replaceAll(/(^|\s)>+\s*/g, "$1")
    .replaceAll(/(^|\s)[*-]\s+/g, "$1")
    .replaceAll(/[*_~`]+/g, "")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function sanitizeSnippet(snippet?: string): string | undefined {
  if (!snippet) {
    return undefined;
  }

  return escapeHtml(stripMarkdownPreviewSyntax(snippet))
    .replaceAll("&lt;b&gt;", "<b>")
    .replaceAll("&lt;/b&gt;", "</b>");
}

function formatDate(dateValue?: string): string {
  if (!dateValue) {
    return "Datum onbekend";
  }

  const parsed = new Date(dateValue);
  if (Number.isNaN(parsed.getTime())) {
    return dateValue;
  }

  // Pinned to the zone the meetings are actually held in. Without it this
  // formats in the container's zone (UTC), and a 21:00 meeting -- 19:00Z now
  // that timestamps are real instants (#203) -- would still read correctly,
  // but anything after midnight local would be dated to the previous day.
  return new Intl.DateTimeFormat("nl-NL", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Amsterdam",
  }).format(parsed);
}

function displayOrganization(hit: SearchHit): string {
  const labels = Object.fromEntries(
    listSources().map((source) => [source.key, source.label ?? source.key]),
  );

  if (hit.source_key && labels[hit.source_key]) {
    return labels[hit.source_key];
  }

  return hit.organization ?? "Onbekende organisatie";
}

function compareRecency(left?: string, right?: string): number {
  return (right ?? "").localeCompare(left ?? "");
}

function dedupeLatestHits(hits: SearchHit[]): SearchHit[] {
  const byEntityId = new Map<string, SearchHit>();

  for (const hit of hits) {
    const entityId = hit.entity_id;
    if (!entityId) {
      continue;
    }

    const existing = byEntityId.get(entityId);
    if (!existing || compareRecency(existing.time, hit.time) > 0) {
      byEntityId.set(entityId, hit);
    }
  }

  // A takedown ingests a newer op:"delete" marker per entity_id. It wins the
  // recency dedupe (shadowing older copies) and is then dropped here, so the
  // entity disappears immediately — before the Quickwit janitor physically
  // applies the delete task.
  return [...byEntityId.values()].filter((hit) => hit.op !== "delete");
}

function hasStructuredAgenda(agenda: MeetingAgendaItem[] | undefined): boolean {
  if (!Array.isArray(agenda) || agenda.length === 0) {
    return false;
  }

  return agenda.some(
    (item) =>
      typeof item === "object" && item !== null && Boolean(item.title || item.documents?.length),
  );
}

function dedupeLatestIndexedHits(items: IndexedHit[]): IndexedHit[] {
  const byEntityId = new Map<string, IndexedHit>();

  for (const item of items) {
    const entityId = item.hit.entity_id;
    if (!entityId) {
      continue;
    }

    const existing = byEntityId.get(entityId);
    if (!existing || compareRecency(existing.hit.time, item.hit.time) > 0) {
      byEntityId.set(entityId, item);
    }
  }

  // See dedupeLatestHits: newer op:"delete" markers shadow older copies and
  // are then dropped, hiding taken-down documents immediately.
  return [...byEntityId.values()].filter((item) => item.hit.op !== "delete");
}

/** A hit is presented as the thing a reader wants to open, which is not always
 * the thing that matched: a page belongs to its document, and a transcript
 * belongs to its meeting — that is where the player and the spoken text are. */
function searchResultEntityId(hit: SearchHit): string {
  if (hit.entity_type === "DocumentPage" || hit.entity_type === "Recording") {
    return hit.parent_entity_id ?? hit.entity_id ?? "";
  }
  return hit.entity_id ?? "";
}

function searchResultEntityType(hit: SearchHit): string {
  if (hit.entity_type === "DocumentPage") {
    return "Document";
  }
  if (hit.entity_type === "Recording") {
    return "Meeting";
  }
  return hit.entity_type ?? "Unknown";
}

function preferIndexedHit(existing: IndexedHit | undefined, candidate: IndexedHit): boolean {
  if (!existing) {
    return true;
  }

  // A transcript and its meeting collapse onto the same result. Decide that
  // pair on which one actually matched, before the recency rule gets to it:
  // recency exists to pick the newest projection of one entity, and by this
  // point every entity has already been reduced to its latest commit. Between
  // two *different* entities it is just noise, and it would hand the summary to
  // whichever happened to be committed a millisecond later — losing the spoken
  // sentence that made the meeting surface.
  const existingIsRecording = existing.hit.entity_type === "Recording";
  const candidateIsRecording = candidate.hit.entity_type === "Recording";
  if (existingIsRecording !== candidateIsRecording) {
    const existingMatched = Boolean(existing.snippet?.content?.[0]);
    const candidateMatched = Boolean(candidate.snippet?.content?.[0]);
    if (existingMatched !== candidateMatched) {
      return candidateMatched;
    }
    return candidateIsRecording;
  }

  const recency = compareRecency(existing.hit.time, candidate.hit.time);
  if (recency !== 0) {
    return recency > 0;
  }

  // Prefer DocumentPage hits over Document hits — they carry matchedPage
  // which lets the PDF viewer open to the right page.
  const existingIsPage = existing.hit.entity_type === "DocumentPage";
  const candidateIsPage = candidate.hit.entity_type === "DocumentPage";
  if (existingIsPage !== candidateIsPage) {
    return candidateIsPage;
  }

  const existingHasSnippet = Boolean(existing.snippet?.content?.[0] ?? existing.snippet?.name?.[0]);
  const candidateHasSnippet = Boolean(
    candidate.snippet?.content?.[0] ?? candidate.snippet?.name?.[0],
  );
  if (existingHasSnippet !== candidateHasSnippet) {
    return candidateHasSnippet;
  }

  const existingPage = existing.hit.page_number ?? Number.MAX_SAFE_INTEGER;
  const candidatePage = candidate.hit.page_number ?? Number.MAX_SAFE_INTEGER;
  return candidatePage < existingPage;
}

function groupIndexedHits(items: IndexedHit[]): IndexedHit[] {
  const grouped = new Map<string, IndexedHit>();

  for (const item of items) {
    const key = searchResultEntityId(item.hit);
    if (!key) {
      continue;
    }

    if (preferIndexedHit(grouped.get(key), item)) {
      grouped.set(key, item);
    }
  }

  return [...grouped.values()];
}

/** Which fields to ask Quickwit to snippet.
 *
 * Only a query long enough to be meaningful gets snippets; they are the
 * expensive part of the response and a two-letter query highlights noise.
 *
 * This used to also return a `maxHits` cap, which is what truncated the scan
 * window at 96 rows and left pages short (#193). Sizing the scan now belongs
 * to the collection loop, which knows how many results it still needs. */
function searchSamplingOptions(
  query: string,
  _offset: number,
  _limit: number,
): { snippetFields: string[] } {
  return { snippetFields: query.trim().length >= 4 ? ["content", "name"] : [] };
}

async function collectSearchWindow(
  quickwit: QuickwitClient,
  options: {
    query: string;
    organization: string;
    entityType: string;
    sort: string;
    offset: number;
    limit: number;
    dateFrom: string;
    dateTo: string;
    previewUrlForKey?: (key: string) => Promise<string | undefined>;
    recordTiming?: SearchTimingRecorder;
  },
): Promise<{
  results: SearchResult[];
  totalCount: number;
  totalIsApproximate: boolean;
  hasMore: boolean;
}> {
  const queryString = buildQuickwitQuery(
    options.query,
    options.organization,
    options.entityType,
    options.dateFrom,
    options.dateTo,
  );
  const sortBy = quickwitSortBy(options.sort);
  const isDirectWindow = !options.query.trim();
  const targetCount = isDirectWindow ? options.limit + 1 : options.offset + options.limit + 1;
  // Scan until the page is full, not until a fixed number of rows is spent.
  //
  // The index holds several rows per result -- one per page of a PDF, plus one
  // per commit -- and those rows collapse into one result by dedup and
  // grouping. That collapse happened *after* the scan window was truncated at
  // 96 rows, so a request for 24 results returned 13, a request for 100
  // returned 31, and paging past that hit an empty list with hasMore still
  // true (#193). Measured on the reindexed data: 6.7 page rows per document.
  //
  // The loop already knew how to keep going; only its budget was wrong.
  const scanBudget = isDirectWindow ? options.offset + options.limit + 1 : MAX_SCAN_ROWS;
  const collected = new Map<string, SearchResult>();
  const previewKeys = new Map<string, string>();
  let rawOffset = isDirectWindow ? options.offset : 0;
  let rawSeen = 0;
  let rawNumHits: number | undefined;
  let exhausted = false;
  let scanLimitReached = false;
  let quickwitMs = 0;
  let shapeMs = 0;
  // Refined from what comes back, so a corpus with few pages per document does
  // not pay for a pessimistic guess and one with many still fills its page.
  let rowsPerResult = INITIAL_ROWS_PER_RESULT;

  while (!exhausted && collected.size < targetCount && rawSeen < scanBudget) {
    const { snippetFields } = searchSamplingOptions(options.query, options.offset, options.limit);
    const wanted = Math.ceil((targetCount - collected.size) * rowsPerResult);
    const requestMaxHits = isDirectWindow
      ? Math.min(options.limit + 1, scanBudget - rawSeen)
      : Math.min(Math.max(wanted, MIN_SCAN_BATCH_ROWS), SCAN_BATCH_ROWS, scanBudget - rawSeen);
    const quickwitStart = performance.now();
    const response = await quickwit.searchRequest({
      query: queryString,
      max_hits: requestMaxHits,
      start_offset: rawOffset,
      // Undocumented in Quickwit 0.8.1's search API, so possibly a no-op --
      // but it was added deliberately, and if it does bind, dropping it turns
      // on full hit counting for every public search. Left alone until someone
      // measures it.
      count_all: false,
      ...(sortBy ? { sort_by: sortBy } : {}),
      ...(snippetFields.length > 0 ? { snippet_fields: snippetFields.join(",") } : {}),
    });
    quickwitMs += performance.now() - quickwitStart;

    // num_hits describes the query, not the window, so it is taken once. The
    // running maximum this replaces made the count depend on how many
    // iterations the loop happened to run: ingestion publishes splits
    // continuously, so a later iteration can honestly report a larger number,
    // and two identical requests were then counted differently depending on
    // how quickly each filled its page (#195).
    if (rawNumHits === undefined) {
      rawNumHits = response.num_hits;
    }
    const hits = response.hits as SearchHit[];
    if (hits.length === 0) {
      exhausted = true;
      break;
    }

    const shapeStart = performance.now();
    const indexedHits = hits.map((hit, index) => ({
      hit,
      snippet: response.snippets?.[index] as SearchSnippet | undefined,
    }));
    const dedupedHits = groupIndexedHits(dedupeLatestIndexedHits(indexedHits));

    for (const { hit: document, snippet: snippets } of dedupedHits) {
      const snippetHtml = sanitizeSnippet(snippets?.content?.[0] ?? snippets?.name?.[0]);
      const normalizedEntityType = searchResultEntityType(document);
      const resultEntityId = searchResultEntityId(document);
      const canPreviewPdf =
        normalizedEntityType === "Document" &&
        looksLikePdf({
          contentType: document.content_type ?? document.payload?.media_urls?.[0]?.content_type,
          fileName: document.file_name,
          url: document.payload?.media_urls?.[0]?.url ?? document.payload?.original_url,
        });
      const result: SearchResult = {
        entityId: resultEntityId,
        organization: displayOrganization(document),
        entityType: normalizedEntityType,
        entityTypeLabel: entityTypeLabel(normalizedEntityType),
        date: formatDate(document.start_date),
        sortDate: document.start_date,
        title:
          document.name ??
          (normalizedEntityType === "Document"
            ? (document.file_name ?? "Ongetiteld document")
            : "Ongetitelde vergadering"),
        summary: snippetHtml
          ? snippetHtml.replaceAll(/<\/?b>/g, "")
          : summarizeContent(document.content),
        summaryHtml: snippetHtml,
        downloadUrl: document.payload?.media_urls?.[0]?.url ?? document.payload?.original_url,
        matchedPage: document.entity_type === "DocumentPage" ? document.page_number : undefined,
        pageCount: document.payload?.derived_content?.page_count,
      };
      if (canPreviewPdf) {
        previewKeys.set(resultEntityId, pdfPageCacheKey(resultEntityId, 1));
      }

      const existing = collected.get(result.entityId);
      if (!existing) {
        collected.set(result.entityId, result);
      }
    }

    rawOffset += hits.length;
    rawSeen += hits.length;
    if (collected.size > 0) {
      rowsPerResult = Math.max(1, rawSeen / collected.size);
    }
    scanLimitReached = rawSeen >= scanBudget && rawOffset < response.num_hits;
    exhausted = scanLimitReached || rawOffset >= response.num_hits || hits.length < requestMaxHits;
    shapeMs += performance.now() - shapeStart;
  }

  const filterSortStart = performance.now();
  const filteredResults = filterResultsByDateRange([...collected.values()], {
    dateFrom: options.dateFrom,
    dateTo: options.dateTo,
  });
  const sortedResults = sortResults(filteredResults, options.sort);
  const filterSortMs = performance.now() - filterSortStart;

  const pageResults = sortedResults.slice(options.offset, options.offset + options.limit);
  const pageWindowResults = isDirectWindow ? sortedResults.slice(0, options.limit) : pageResults;
  const pageHasResults = pageWindowResults.length > 0;
  const previewStart = performance.now();
  if (options.previewUrlForKey) {
    await Promise.all(
      pageWindowResults.map(async (result) => {
        const key = previewKeys.get(result.entityId);
        if (!key) {
          return;
        }
        result.previewImageUrl = await options.previewUrlForKey!(key);
      }),
    );
  }
  const previewMs = performance.now() - previewStart;

  options.recordTiming?.({ name: "quickwit", durationMs: quickwitMs });
  options.recordTiming?.({ name: "shape", durationMs: shapeMs });
  options.recordTiming?.({ name: "filter_sort", durationMs: filterSortMs });
  options.recordTiming?.({ name: "preview", durationMs: previewMs });

  // Count results, not rows.
  //
  // totalCount was Quickwit's raw num_hits, which counts index rows: it read
  // 9,933 where the source holds a few thousand documents, moved between 4,153
  // and 9,933 across identical requests, and could rise when a filter was
  // narrowed (#195). None of that is usable for "about N results", for paging,
  // or for comparing two searches.
  //
  // When the scan reached the end of the matching set the grouped count is
  // simply exact. When it stopped at the budget, scale the row count by the
  // collapse ratio actually observed -- an estimate, and flagged as one.
  //
  // That estimate is still a sample, and on the v2 projection the sample is
  // drawn in an undefined order: quickwitSortBy() returns nothing there, so
  // paginating with start_offset over an unsorted distributed query can show
  // the same row in two windows or in none. The collapse ratio therefore still
  // moves a little between identical requests. Quickwit 0.8.1 has no
  // cardinality aggregation to ask for a distinct count instead, so this
  // settles only when the v3 projection makes the scan order defined -- the
  // same switch #184, #192 and #194 are waiting on.
  const groupedCount = sortedResults.length;
  const scannedEverything = exhausted && !scanLimitReached;
  const totalCount = scannedEverything
    ? groupedCount
    : Math.max(groupedCount, Math.round((rawNumHits ?? 0) / Math.max(rowsPerResult, 1)));

  return {
    results: pageWindowResults,
    totalCount,
    totalIsApproximate: !scannedEverything,
    hasMore:
      pageHasResults &&
      ((isDirectWindow
        ? sortedResults.length > options.limit
        : sortedResults.length > options.offset + options.limit) ||
        !exhausted ||
        scanLimitReached),
  };
}

function monthKey(month: Date): string {
  const year = month.getUTCFullYear();
  const value = String(month.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${value}`;
}

function coverageMonthLabels(monthCount: number): string[] {
  const now = new Date();
  const currentMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const months: string[] = [];
  for (let offset = monthCount - 1; offset >= 0; offset -= 1) {
    const month = new Date(currentMonth);
    month.setUTCMonth(month.getUTCMonth() - offset);
    months.push(monthKey(month));
  }
  return months;
}

export async function getDocumentCoverage(monthCount = 12): Promise<AdminCoverageResponse> {
  const months = coverageMonthLabels(Math.max(3, Math.min(monthCount, 60)));
  const coverageSources = listSources();
  const quickwit = new QuickwitClient();
  const response = await quickwit.searchRequest({
    query: `projection_version:${escapeTerm(currentProjectionVersion())} AND entity_type:Document`,
    max_hits: 0,
    aggs: {
      by_source: {
        terms: {
          field: "source_key",
          size: 400,
        },
        aggs: {
          by_month: {
            terms: {
              field: "document_month",
              size: months.length,
            },
          },
        },
      },
    },
  });

  const sourceBuckets = ((response.aggregations?.by_source as { buckets?: CoverageBucket[] })
    ?.buckets ?? []) as CoverageBucket[];
  const bySource = new Map(sourceBuckets.map((bucket) => [bucket.key ?? "", bucket]));
  let maxDocumentCount = 0;

  const rows: AdminCoverageRow[] = coverageSources
    .map((source) => {
      const sourceBucket = bySource.get(source.key);
      const byMonth = new Map(
        (sourceBucket?.by_month?.buckets ?? []).map((bucket) => [
          String(bucket.key ?? ""),
          Number(bucket.doc_count ?? 0),
        ]),
      );
      const monthCells: AdminCoverageCell[] = months.map((month) => ({
        month,
        documentCount: byMonth.get(month) ?? 0,
        meetingCount: 0,
        issueCount: 0,
      }));
      const totalDocumentCount = monthCells.reduce((sum, cell) => sum + cell.documentCount, 0);
      const coveredMonthCount = monthCells.filter((cell) => cell.documentCount > 0).length;
      maxDocumentCount = Math.max(
        maxDocumentCount,
        ...monthCells.map((cell) => cell.documentCount),
      );

      return {
        sourceKey: source.key,
        label: source.label ?? source.key,
        supplier: source.supplier,
        organizationType: source.organizationType,
        months: monthCells,
        totalDocumentCount,
        coveredMonthCount,
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label, "nl"));

  return {
    months,
    rows,
    maxDocumentCount,
  };
}

export interface SourceIndexActivity {
  /** Newest `start_date` held for the source: the meeting furthest in the
   * future whose agenda we already have. */
  latestContentDate?: string;
  /** Newest `time`: when we last wrote anything at all for the source. */
  lastIndexedAt?: string;
}

/** Quickwit reports datetime metric aggregations as nanoseconds since the
 * epoch, in a JSON number. At present-day timestamps that is ~19 digits
 * against a float64's ~15-16 significant ones, so the value is only good to
 * roughly the microsecond — three orders of magnitude finer than the second
 * this ends up rendered at. */
function fromAggregationTimestamp(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const date = new Date(value / 1_000_000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** When each source last received data, for all sources in one query.
 *
 * The point of the status endpoint is that a caller does not have to ask 330
 * times; this must not become 330 questions on our side either. A terms
 * aggregation with `size` above the number of distinct sources returns exact
 * counts and every bucket, so one request covers the fleet.
 *
 * `start_date` is only a datetime fast field on projections that map it (see
 * projectionSupportsDateSort) -- on v2 it is a dynamic string and a metric
 * aggregation over it fails the whole request, which is how sorting took
 * search down in August 2026. So it is only asked for where it exists. */
export async function getSourceIndexActivity(): Promise<Map<string, SourceIndexActivity>> {
  const quickwit = new QuickwitClient();
  const withStartDate = projectionSupportsDateSort();

  let response: Awaited<ReturnType<QuickwitClient["searchRequest"]>>;
  try {
    response = await quickwit.searchRequest({
      query: `projection_version:${escapeTerm(currentProjectionVersion())}`,
      max_hits: 0,
      aggs: {
        by_source: {
          terms: { field: "source_key", size: 500 },
          aggs: {
            last_indexed: { max: { field: "time" } },
            ...(withStartDate ? { latest_start_date: { max: { field: "start_date" } } } : {}),
          },
        },
      },
    });
  } catch (error) {
    // A fresh local stack has no index yet. Everything else -- Quickwit down,
    // slow, mid-reindex -- is the caller's to handle: the status endpoint
    // still has the import-run half of the answer, and dropping that too
    // because search is unwell is exactly the failure this endpoint exists
    // to make visible.
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("could not find indexes matching")) {
      return new Map();
    }
    throw error;
  }

  const buckets = ((response.aggregations?.by_source as { buckets?: unknown[] })?.buckets ??
    []) as Array<{
    key?: unknown;
    last_indexed?: { value?: unknown };
    latest_start_date?: { value?: unknown };
  }>;

  const activity = new Map<string, SourceIndexActivity>();
  for (const bucket of buckets) {
    const sourceKey = String(bucket.key ?? "");
    if (!sourceKey) continue;
    activity.set(sourceKey, {
      lastIndexedAt: fromAggregationTimestamp(bucket.last_indexed?.value),
      latestContentDate: fromAggregationTimestamp(bucket.latest_start_date?.value),
    });
  }
  return activity;
}

export async function searchMeetings(
  options: {
    query?: string;
    organization?: string;
    entityType?: string;
    sort?: string;
    dateFrom?: string;
    dateTo?: string;
    offset?: number;
    limit?: number;
    recordTiming?: SearchTimingRecorder;
  } = {},
): Promise<SearchResponse> {
  const query = options.query?.trim() ?? "";
  const organization = options.organization?.trim() ?? "";
  const entityType = options.entityType?.trim() ?? "";
  const sort = options.sort?.trim() ?? "date_desc";
  const dateFrom = options.dateFrom?.trim() ?? "";
  const dateTo = options.dateTo?.trim() ?? "";
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.max(1, Math.min(options.limit ?? 24, 100));

  if (!query && !organization) {
    return {
      results: [],
      totalCount: 0,
      totalIsApproximate: false,
      hasMore: false,
    };
  }

  const quickwit = new QuickwitClient();
  let previewUrlForKey: ((key: string) => Promise<string | undefined>) | undefined;
  try {
    const sampleUrl = await ObjectStorageClient.publicUrlForKey("__woozi_preview_base__");
    const baseUrl = sampleUrl.slice(0, -"__woozi_preview_base__".length);
    previewUrlForKey = (key) => cachedPublicPreviewUrl(`${baseUrl}${key}`);
  } catch {
    previewUrlForKey = undefined;
  }
  return await collectSearchWindow(quickwit, {
    query,
    organization,
    entityType,
    sort,
    dateFrom,
    dateTo,
    offset,
    limit,
    previewUrlForKey,
    recordTiming: options.recordTiming,
  });
}

export async function getEntityContent(
  entityId: string,
  /** Internal: stops a motion's attachment lookup from recursing. An
   * attachment that itself advertises one would otherwise loop forever, and a
   * self-referential id is enough to hang the request. */
  resolveAttachment = true,
): Promise<EntityContentResponse | null> {
  const quickwit = new QuickwitClient();
  const response = await quickwit.search(
    `projection_version:${escapeTerm(currentProjectionVersion())} AND entity_id:${escapeTerm(entityId)}`,
    8,
  );
  const hit = dedupeLatestHits(response.hits as SearchHit[])[0];

  if (!hit) {
    return null;
  }

  const mediaUrl = hit.payload?.media_urls?.[0];
  const downloadUrl = mediaUrl?.url ?? hit.payload?.original_url;
  const contentType = mediaUrl?.content_type ?? hit.content_type;
  const pdfUrl = looksLikePdf({
    contentType,
    fileName: hit.file_name,
    url: downloadUrl,
  })
    ? downloadUrl
    : undefined;

  let markdownText: string | undefined;
  const markdownKey = hit.payload?.derived_content?.markdown_key;

  if (markdownKey) {
    const storage = await ObjectStorageClient.fromEnvironment();
    markdownText = await storage.getObjectText(markdownKey);
  }

  let agenda = hit.payload?.agenda;
  if (hit.entity_type === "Meeting" && !hasStructuredAgenda(agenda) && hit.source_key) {
    const source = getSource(hit.source_key);
    if (source.supplier === "notubiz") {
      const meetingId = entityId.split(":").at(-1);
      if (meetingId) {
        const client = new NotubizClient();
        const meetingResponse = await client.getMeeting(Number(meetingId));
        const rawMeeting =
          meetingResponse && typeof meetingResponse === "object"
            ? (meetingResponse as { meeting?: unknown }).meeting
            : undefined;
        if (rawMeeting && typeof rawMeeting === "object") {
          const record = rawMeeting as Record<string, unknown>;
          agenda = normalizeNotubizAgendaItems(
            source,
            Array.isArray(record.agenda_items) ? record.agenda_items : [],
          );
        }
      }
    }
  }

  const motions = hit.entity_type === "Meeting" ? await getMeetingMotions(entityId) : undefined;
  const recordings =
    hit.entity_type === "Meeting" ? await getMeetingRecordings(entityId) : undefined;
  const motion = hit.entity_type === "Motion" ? motionFromHit(hit) : undefined;

  // A motion carries its outcome and its votes, but the text people came to
  // read lives in the PDF hanging off it — the motion entity itself has no
  // derived content, so the reader fell through to "geen documenttekst
  // beschikbaar" while the very same text sat one hop away on the attachment.
  let motionAttachment: EntityContentResponse | null = null;
  const attachmentId = hit.payload?.attachment?.[0];
  if (motion && resolveAttachment && attachmentId && attachmentId !== entityId) {
    motionAttachment = await getEntityContent(attachmentId, false);
  }

  return {
    entityId: hit.entity_id ?? entityId,
    entityType: hit.entity_type ?? "Unknown",
    entityTypeLabel: entityTypeLabel(hit.entity_type),
    title:
      hit.name ??
      (hit.entity_type === "Document"
        ? (hit.file_name ?? "Ongetiteld document")
        : "Ongetitelde vergadering"),
    organization: displayOrganization(hit),
    date: formatDate(hit.start_date),
    sortDate: hit.start_date,
    // Fall back to the attachment's text and file for a motion; its own
    // fields are always empty.
    markdownText: markdownText ?? motionAttachment?.markdownText,
    downloadUrl: downloadUrl ?? motionAttachment?.downloadUrl,
    contentType: contentType ?? motionAttachment?.contentType,
    pdfUrl: pdfUrl ?? motionAttachment?.pdfUrl,
    pdfEntityId: pdfUrl ? undefined : motionAttachment?.entityId,
    meetingId: hit.payload?.is_referenced_by ?? hit.payload?.meeting,
    agenda,
    motions: motions && motions.length > 0 ? motions : undefined,
    recordings: recordings && recordings.length > 0 ? recordings : undefined,
    motion,
  };
}

/** Shape a Motion search hit into the payload the detail endpoint returns. */
function motionFromHit(hit: SearchHit): MeetingMotion {
  return {
    id: hit.entity_id ?? "",
    name: hit.name ?? "Ongetitelde motie",
    motion_type: hit.payload?.motion_type,
    status: hit.payload?.status,
    result: hit.payload?.result,
    date: hit.payload?.date,
    proposers: hit.payload?.proposers,
    co_proposers: hit.payload?.co_proposers,
    parties: hit.payload?.parties,
    votes: hit.payload?.votes,
    tally: hit.payload?.tally,
    vote_summary: hit.payload?.vote_summary,
    agenda_item: hit.payload?.agenda_item,
    agenda_item_hint: hit.payload?.agenda_item_hint,
    attachment_id: hit.payload?.attachment?.[0],
  };
}

/** Recordings of a meeting, with their transcript read back from storage.
 *
 * The transcript is deliberately absent from the search payload — it is ~30 KB
 * and would be repeated in every stored hit — so the detail endpoint is the one
 * place that pays for reading it. A recording whose transcript cannot be read
 * is still returned: the player and its agenda timeline work without it. */
async function getMeetingRecordings(meetingId: string): Promise<MeetingRecording[]> {
  const quickwit = new QuickwitClient();
  const response = await quickwit.search(
    `projection_version:${escapeTerm(currentProjectionVersion())}` +
      ` AND entity_type:Recording AND parent_entity_id:${escapeTerm(meetingId)}`,
    20,
  );

  const hits = dedupeLatestHits(response.hits as SearchHit[]).filter((hit) => hit.entity_id);
  if (hits.length === 0) {
    return [];
  }

  let storage: ObjectStorageClient | undefined;
  const transcriptKeys = hits.map((hit) => hit.payload?.derived_content?.transcript_key);
  if (transcriptKeys.some(Boolean)) {
    try {
      storage = await ObjectStorageClient.fromEnvironment();
    } catch {
      storage = undefined;
    }
  }

  return await Promise.all(
    hits.map(async (hit, index) => {
      const payload = hit.payload ?? {};
      const key = transcriptKeys[index];
      const stored = storage && key ? await readTranscript(storage, key) : undefined;

      return {
        id: hit.entity_id ?? "",
        name: hit.name ?? "Opname",
        media_type: payload.media_type === "audio" ? "audio" : "video",
        stream_url: payload.stream_url,
        // A recording carries a single `media_url`; `media_urls` is the
        // Document shape and is always empty here.
        media_url: payload.media_url,
        player_url: payload.player_url,
        duration_seconds: payload.duration_seconds,
        transcript_kind: payload.transcript_kind,
        chapters: stored?.chapters ?? payload.chapters,
        speakers: stored?.speakers ?? payload.speakers,
        segments: stored?.segments,
      } satisfies MeetingRecording;
    }),
  );
}

/** Motions decided in a meeting.
 *
 * Motions are projected with `parent_entity_id` set to their meeting, the same
 * way document pages hang off their document, so one term query finds them. */
async function getMeetingMotions(meetingId: string): Promise<MeetingMotion[]> {
  const quickwit = new QuickwitClient();
  const response = await quickwit.search(
    `projection_version:${escapeTerm(currentProjectionVersion())}` +
      ` AND entity_type:Motion AND parent_entity_id:${escapeTerm(meetingId)}`,
    100,
  );

  const motions = dedupeLatestHits(response.hits as SearchHit[])
    .filter((hit) => hit.entity_id)
    .map(motionFromHit);

  return await withAttachmentDownloads(motions);
}

/** Resolve every motion's download link in one query instead of one per motion.
 *
 * A budget debate carries dozens of motions and the detail sheet already waits
 * on several round trips before it can paint, so this stays a single search
 * however long the agenda is. Motions whose attachment cannot be resolved keep
 * their other fields — the pill simply shows no download. */
async function withAttachmentDownloads(motions: MeetingMotion[]): Promise<MeetingMotion[]> {
  const ids = [
    ...new Set(
      motions.map((motion) => motion.attachment_id).filter((id): id is string => Boolean(id)),
    ),
  ];
  if (ids.length === 0) {
    return motions;
  }

  const quickwit = new QuickwitClient();
  const clause = ids.map((id) => `entity_id:${escapeTerm(id)}`).join(" OR ");
  let hits: SearchHit[] = [];
  try {
    const response = await quickwit.search(
      `projection_version:${escapeTerm(currentProjectionVersion())} AND (${clause})`,
      Math.min(ids.length * 3, 300),
    );
    hits = dedupeLatestHits(response.hits as SearchHit[]);
  } catch (error) {
    console.warn("kon bijlagen van moties niet ophalen", error);
    return motions;
  }

  const byId = new Map<string, { url?: string; isPdf: boolean }>();
  for (const hit of hits) {
    if (!hit.entity_id) {
      continue;
    }
    const mediaUrl = hit.payload?.media_urls?.[0];
    const url = mediaUrl?.url ?? hit.payload?.original_url;
    byId.set(hit.entity_id, {
      url,
      isPdf: looksLikePdf({
        contentType: mediaUrl?.content_type ?? hit.content_type,
        fileName: hit.file_name,
        url,
      }),
    });
  }

  return motions.map((motion) => {
    const attachment = motion.attachment_id ? byId.get(motion.attachment_id) : undefined;
    if (!attachment) {
      return motion;
    }
    return {
      ...motion,
      download_url: attachment.url,
      attachment_is_pdf: attachment.isPdf,
    };
  });
}

export async function getEntityPdfInfo(entityId: string): Promise<{
  pdfUrl?: string;
  contentType?: string;
} | null> {
  const quickwit = new QuickwitClient();
  const response = await quickwit.search(
    `projection_version:${escapeTerm(currentProjectionVersion())} AND entity_id:${escapeTerm(entityId)}`,
    8,
  );
  const hit = dedupeLatestHits(response.hits as SearchHit[])[0];

  if (!hit) {
    return null;
  }

  const mediaUrl = hit.payload?.media_urls?.[0];
  const downloadUrl = mediaUrl?.url ?? hit.payload?.original_url;
  const contentType = mediaUrl?.content_type ?? hit.content_type;
  const pdfUrl = looksLikePdf({
    contentType,
    fileName: hit.file_name,
    url: downloadUrl,
  })
    ? downloadUrl
    : undefined;

  return {
    pdfUrl,
    contentType,
  };
}

export interface IndexStats {
  documentCount: number;
  organizationCount: number;
  municipalityCount: number;
  waterBoardCount: number;
  provinceCount: number;
}

const EMPTY_INDEX_STATS: IndexStats = {
  documentCount: 0,
  organizationCount: 0,
  municipalityCount: 0,
  waterBoardCount: 0,
  provinceCount: 0,
};

// Process-local memo so the Quickwit aggregation doesn't run per-request.
// Failures and the "empty index" fallback are not cached so they don't pin
// a bad result; a fresh local stack will pick up real data on the next call
// after its index appears.
//
// startStatsRefreshLoop() keeps this warm in the background (see server.ts),
// so in steady state a request never waits on computeIndexStats() at all;
// STATS_CACHE_TTL_MS is only the fallback if that loop ever stalls. The
// on-disk copy exists purely to survive a restart (this app redeploys ~7x/day
// -- an in-memory-only cache would force a full recompute, Quickwit
// aggregation included, on the very first request after every deploy).
const STATS_CACHE_TTL_MS = 30 * 60 * 1000;
const STATS_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
let cachedStats: { value: IndexStats; expiresAt: number } | null = null;
let statsInFlight: Promise<IndexStats> | null = null;

async function statsCachePath(): Promise<string> {
  return await getConfigValue("WOOZI_STATS_CACHE_PATH", "./woozi-stats-cache.json");
}

async function loadPersistedStats(): Promise<void> {
  try {
    const raw = await Deno.readTextFile(await statsCachePath());
    const value = JSON.parse(raw) as IndexStats;
    if (value.documentCount > 0) {
      cachedStats = { value, expiresAt: Date.now() + STATS_CACHE_TTL_MS };
    }
  } catch {
    // No persisted cache yet (fresh environment, or first deploy after this
    // change) -- the next computeIndexStats() call seeds it as usual.
  }
}

async function persistStats(value: IndexStats): Promise<void> {
  try {
    await Deno.writeTextFile(await statsCachePath(), JSON.stringify(value));
  } catch {
    // Best-effort: an unwritable cache file must not fail the request or the
    // refresh loop, it just means the next restart recomputes cold again.
  }
}

async function refreshStats(): Promise<IndexStats> {
  if (statsInFlight) {
    return statsInFlight;
  }
  statsInFlight = computeIndexStats()
    .then((result) => {
      if (result.documentCount > 0) {
        cachedStats = { value: result, expiresAt: Date.now() + STATS_CACHE_TTL_MS };
        void persistStats(result);
      }
      return result;
    })
    .finally(() => {
      statsInFlight = null;
    });
  return statsInFlight;
}

export async function getIndexStats(): Promise<IndexStats> {
  if (cachedStats && Date.now() < cachedStats.expiresAt) {
    return cachedStats.value;
  }
  return refreshStats();
}

/** Fire-and-forget refresh that can never take the process down.
 *
 * computeIndexStats() rejects on a Quickwit search timeout (AbortSignal, 8s x
 * the retry budget), and Deno terminates the process on an unhandled promise
 * rejection -- so an un-caught background refresh turns a *transient* Quickwit
 * slowdown into a web-server crash loop: start -> refresh -> reject ~16s later
 * -> exit -> restart -> repeat. Observed in production 2026-07-25. Request-path
 * callers go through getIndexStats() and handle their own errors; this wrapper
 * is only for the callers that discard the promise. */
function refreshStatsInBackground(): void {
  refreshStats().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[stats] background refresh failed, keeping previous value: ${message}`);
  });
}

/** Proactively keeps the stats cache warm so requests never pay for
 * computeIndexStats() (a Quickwit aggregation plus an export-log scan).
 * Seeds from the on-disk copy first so a freshly deployed container serves a
 * real (if briefly stale) number instead of an empty/default one. */
export async function startStatsRefreshLoop(): Promise<void> {
  await loadPersistedStats();
  refreshStatsInBackground();
  setInterval(refreshStatsInBackground, STATS_REFRESH_INTERVAL_MS);
}

async function computeIndexStats(): Promise<IndexStats> {
  const quickwit = new QuickwitClient();
  let response: Awaited<ReturnType<QuickwitClient["searchRequest"]>>;
  try {
    response = await quickwit.searchRequest({
      // The count is documents only: meetings and per-page rows are not
      // "vergaderstukken". Quickwit's number is still per-commit (one row per
      // re-commit); the deduplicated count from the export log below wins
      // when available.
      query: `projection_version:${escapeTerm(currentProjectionVersion())} AND entity_type:Document`,
      max_hits: 0,
      aggs: {
        organizations: {
          terms: { field: "organization", size: 1000 },
        },
        source_keys: {
          terms: { field: "source_key", size: 1000 },
        },
      },
    });
  } catch (error) {
    // On a fresh local stack Quickwit may not have the index yet.
    // Treat missing index as empty stats instead of failing the landing page.
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("could not find indexes matching")) {
      return { ...EMPTY_INDEX_STATS };
    }
    throw error;
  }

  const orgBuckets =
    (response.aggregations?.organizations as { buckets?: unknown[] })?.buckets ?? [];
  const sourceKeyBuckets =
    (response.aggregations?.source_keys as { buckets?: { key?: unknown }[] })?.buckets ?? [];

  const typeBySourceKey = new Map(
    listSources().map((source) => [source.key, source.organizationType]),
  );
  let municipalityCount = 0;
  let waterBoardCount = 0;
  let provinceCount = 0;
  for (const bucket of sourceKeyBuckets) {
    switch (typeBySourceKey.get(String(bucket.key ?? ""))) {
      case "gemeente":
        municipalityCount += 1;
        break;
      case "waterschap":
        waterBoardCount += 1;
        break;
      case "provincie":
        provinceCount += 1;
        break;
    }
  }

  // Deduplicated document count from the export log (one row per entity);
  // the Quickwit hit count is per-commit and overstates roughly 3.5x. Falls
  // back to the Quickwit count while the export log is still catching up
  // (fresh environments, and until the full-history backfill has touched
  // every entity at least once).
  let uniqueDocumentCount = 0;
  try {
    uniqueDocumentCount = (await getExportLog()).countLiveEntities("document:");
  } catch {
    // No export log (e.g. read-only local setup): keep the Quickwit count.
  }

  return {
    documentCount: uniqueDocumentCount > 0 ? uniqueDocumentCount : response.num_hits,
    organizationCount: orgBuckets.length,
    municipalityCount,
    waterBoardCount,
    provinceCount,
  };
}

export const __test__ = {
  quickwitSortBy,
  startDateRangeClause,
  buildQuickwitQuery,
  entityTypeLabel,
  searchResultEntityId,
  searchResultEntityType,
  preferIndexedHit,
};
