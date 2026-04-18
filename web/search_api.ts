import type {
  AdminCoverageCell,
  AdminCoverageResponse,
  AdminCoverageRow,
  EntityContentResponse,
  MeetingAgendaItem,
  SearchResponse,
  SearchResult,
} from "../src/types.ts";
import { NotubizClient } from "../src/notubiz/client.ts";
import { normalizeNotubizAgendaItems } from "../src/notubiz/normalize.ts";
import { currentProjectionVersion } from "../src/pipeline/versioning.ts";
import { QuickwitClient } from "../src/quickwit/client.ts";
import { getSource, listSources } from "../src/sources/index.ts";
import { ObjectStorageClient } from "../src/storage/s3.ts";

type SearchHit = {
  time?: string;
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
    };
    is_referenced_by?: string;
    agenda?: MeetingAgendaItem[];
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

function escapeTerm(term: string): string {
  return `"${term.replaceAll('"', '\\"')}"`;
}

function buildSearchClause(text: string): string {
  const tokens = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return "";
  }
  if (tokens.length === 1) {
    return escapeTerm(tokens[0]);
  }
  return `(${tokens.map(escapeTerm).join(" AND ")})`;
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

function buildQuickwitQuery(query: string, organization: string, entityType: string): string {
  const typeQuery =
    entityType === "Meeting"
      ? "entity_type:Meeting"
      : entityType === "Document"
        ? query
          ? "(entity_type:Document OR entity_type:DocumentPage)"
          : "entity_type:Document"
        : query
          ? "(entity_type:Meeting OR entity_type:Document OR entity_type:DocumentPage)"
          : "(entity_type:Meeting OR entity_type:Document)";
  const parts = [`projection_version:${escapeTerm(currentProjectionVersion())}`, typeQuery];

  if (organization) {
    parts.push(`source_key:${organization}`);
  }

  if (query) {
    const expandedTerms = expandDutchGovernanceTerms(query);
    if (expandedTerms.length === 1) {
      parts.push(buildSearchClause(expandedTerms[0]));
    } else {
      parts.push(`(${expandedTerms.map(buildSearchClause).filter(Boolean).join(" OR ")})`);
    }
  }

  return parts.join(" AND ");
}

function entityTypeLabel(entityType?: string): string {
  if (entityType === "Document") {
    return "Document";
  }
  if (entityType === "Meeting") {
    return "Vergadering";
  }
  return "Resultaat";
}

function sortResults(results: SearchResult[], sort: string): SearchResult[] {
  const items = [...results];

  if (sort === "date_asc") {
    items.sort((a, b) => (a.sortDate ?? "").localeCompare(b.sortDate ?? ""));
    return items;
  }

  if (sort === "title_asc") {
    items.sort((a, b) => a.title.localeCompare(b.title, "nl"));
    return items;
  }

  items.sort((a, b) => (b.sortDate ?? "").localeCompare(a.sortDate ?? ""));
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

function sanitizeSnippet(snippet?: string): string | undefined {
  if (!snippet) {
    return undefined;
  }

  return escapeHtml(snippet).replaceAll("&lt;b&gt;", "<b>").replaceAll("&lt;/b&gt;", "</b>");
}

function formatDate(dateValue?: string): string {
  if (!dateValue) {
    return "Datum onbekend";
  }

  const parsed = new Date(dateValue);
  if (Number.isNaN(parsed.getTime())) {
    return dateValue;
  }

  return new Intl.DateTimeFormat("nl-NL", {
    day: "numeric",
    month: "long",
    year: "numeric",
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

  return [...byEntityId.values()];
}

function hasStructuredAgenda(agenda: MeetingAgendaItem[] | undefined): boolean {
  if (!Array.isArray(agenda) || agenda.length === 0) {
    return false;
  }

  return agenda.some((item) => typeof item === "object" && item !== null && Boolean(item.title || item.documents?.length));
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

  return [...byEntityId.values()];
}

function searchResultEntityId(hit: SearchHit): string {
  return hit.entity_type === "DocumentPage"
    ? (hit.parent_entity_id ?? hit.entity_id ?? "")
    : (hit.entity_id ?? "");
}

function searchResultEntityType(hit: SearchHit): string {
  return hit.entity_type === "DocumentPage" ? "Document" : (hit.entity_type ?? "Unknown");
}

function preferIndexedHit(existing: IndexedHit | undefined, candidate: IndexedHit): boolean {
  if (!existing) {
    return true;
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

function searchSamplingOptions(query: string, offset: number, limit: number): {
  maxHits: number;
  snippetFields: string[];
} {
  const queryLength = query.trim().length;

  if (queryLength >= 4) {
    return {
      maxHits: Math.min(Math.max((offset + limit) * 3, 72), 240),
      snippetFields: ["content", "name"],
    };
  }

  if (queryLength >= 2) {
    return {
      maxHits: Math.min(Math.max((offset + limit) * 2, 48), 144),
      snippetFields: [],
    };
  }

  return {
    maxHits: Math.min(Math.max(offset + limit, 24), 96),
    snippetFields: [],
  };
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
  },
): Promise<{
  results: SearchResult[];
  totalCount: number;
  totalIsApproximate: boolean;
  hasMore: boolean;
}> {
  const queryString = buildQuickwitQuery(options.query, options.organization, options.entityType);
  const targetCount = options.offset + options.limit + 1;
  const collected = new Map<string, SearchResult>();
  let rawOffset = 0;
  let totalCount = 0;
  let exhausted = false;

  while (!exhausted && collected.size < targetCount) {
    const { maxHits, snippetFields } = searchSamplingOptions(options.query, rawOffset, options.limit);
    const response = await quickwit.searchRequest({
      query: queryString,
      max_hits: maxHits,
      start_offset: rawOffset,
      ...(snippetFields.length > 0 ? { snippet_fields: snippetFields.join(",") } : {}),
    });

    totalCount = response.num_hits;
    const hits = response.hits as SearchHit[];
    if (hits.length === 0) {
      exhausted = true;
      break;
    }

    const indexedHits = hits.map((hit, index) => ({
      hit,
      snippet: response.snippets?.[index] as SearchSnippet | undefined,
    }));
    const dedupedHits = groupIndexedHits(dedupeLatestIndexedHits(indexedHits));

    for (const { hit: document, snippet: snippets } of dedupedHits) {
      const snippetHtml = sanitizeSnippet(snippets?.content?.[0] ?? snippets?.name?.[0]);
      const normalizedEntityType = searchResultEntityType(document);
      const result: SearchResult = {
        entityId: searchResultEntityId(document),
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
        previewImageUrl: normalizedEntityType === "Document" &&
            looksLikePdf({
              contentType: document.content_type ?? document.payload?.media_urls?.[0]?.content_type,
              fileName: document.file_name,
              url: document.payload?.media_urls?.[0]?.url ?? document.payload?.original_url,
            })
          ? `/api/entities/${encodeURIComponent(searchResultEntityId(document))}/pdf/page/${
            document.entity_type === "DocumentPage" && document.page_number ? document.page_number : 1
          }`
          : undefined,
      };

      const existing = collected.get(result.entityId);
      if (!existing) {
        collected.set(result.entityId, result);
      }
    }

    rawOffset += hits.length;
    exhausted = rawOffset >= response.num_hits || hits.length < maxHits;
  }

  const filteredResults = filterResultsByDateRange([...collected.values()], {
    dateFrom: options.dateFrom,
    dateTo: options.dateTo,
  });
  const sortedResults = sortResults(filteredResults, options.sort);

  return {
    results: sortedResults.slice(options.offset, options.offset + options.limit),
    totalCount,
    totalIsApproximate: true,
    hasMore: sortedResults.length > options.offset + options.limit || !exhausted,
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

  const sourceBuckets = ((response.aggregations?.by_source as { buckets?: CoverageBucket[] })?.buckets ??
    []) as CoverageBucket[];
  const bySource = new Map(sourceBuckets.map((bucket) => [bucket.key ?? "", bucket]));
  let maxDocumentCount = 0;

  const rows: AdminCoverageRow[] = coverageSources
    .map((source) => {
      const sourceBucket = bySource.get(source.key);
      const byMonth = new Map(
        ((sourceBucket?.by_month?.buckets ?? []).map((bucket) => [
          String(bucket.key ?? ""),
          Number(bucket.doc_count ?? 0),
        ])),
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
  const quickwit = new QuickwitClient();
  return await collectSearchWindow(quickwit, {
    query,
    organization,
    entityType,
    sort,
    dateFrom,
    dateTo,
    offset,
    limit,
  });
}

export async function getEntityContent(entityId: string): Promise<EntityContentResponse | null> {
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
  if (
    hit.entity_type === "Meeting" &&
    !hasStructuredAgenda(agenda) &&
    hit.source_key
  ) {
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
    markdownText,
    downloadUrl,
    contentType,
    pdfUrl,
    meetingId: hit.payload?.is_referenced_by,
    agenda,
  };
}

export async function getIndexStats(): Promise<{ documentCount: number; organizationCount: number }> {
  const quickwit = new QuickwitClient();
  const response = await quickwit.searchRequest({
    query: `projection_version:${escapeTerm(currentProjectionVersion())}`,
    max_hits: 0,
    aggs: {
      organizations: {
        terms: { field: "organization", size: 1000 },
      },
    },
  });

  const orgBuckets = (response.aggregations?.organizations as { buckets?: unknown[] })?.buckets ?? [];

  return {
    documentCount: response.num_hits,
    organizationCount: orgBuckets.length,
  };
}
