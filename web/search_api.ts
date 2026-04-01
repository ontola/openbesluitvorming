import type { EntityContentResponse, SearchResponse, SearchResult } from "../src/types.ts";
import { QuickwitClient } from "../src/quickwit/client.ts";
import { listSources } from "../src/sources/index.ts";
import { ObjectStorageClient } from "../src/storage/s3.ts";

type SearchHit = {
  time?: string;
  entity_id?: string;
  entity_type?: string;
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
    };
    md_text?: string[];
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
    entityType === "Meeting" || entityType === "Document"
      ? `entity_type:${entityType}`
      : "(entity_type:Meeting OR entity_type:Document)";
  const parts = [typeQuery];

  if (organization) {
    parts.push(`source_key:${organization}`);
  }

  if (query) {
    const expandedTerms = expandDutchGovernanceTerms(query);
    if (expandedTerms.length === 1) {
      parts.push(escapeTerm(expandedTerms[0]));
    } else {
      parts.push(`(${expandedTerms.map(escapeTerm).join(" OR ")})`);
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
  const maxHits = Math.min(Math.max((offset + limit) * 4, 96), 400);
  const response = await quickwit.search(
    buildQuickwitQuery(query, organization, entityType),
    maxHits,
    {
      snippetFields: query ? ["content", "name"] : [],
    },
  );

  const indexedHits = (response.hits as SearchHit[]).map((hit, index) => ({
    hit,
    snippet: response.snippets?.[index] as SearchSnippet | undefined,
  }));
  const dedupedHits = dedupeLatestIndexedHits(indexedHits);

  const results = dedupedHits.map(({ hit: document, snippet: snippets }) => {
    const snippetHtml = sanitizeSnippet(snippets?.content?.[0] ?? snippets?.name?.[0]);

    return {
      entityId: document.entity_id ?? "",
      organization: displayOrganization(document),
      entityType: document.entity_type ?? "Unknown",
      entityTypeLabel: entityTypeLabel(document.entity_type),
      date: formatDate(document.start_date),
      sortDate: document.start_date,
      title:
        document.name ??
        (document.entity_type === "Document"
          ? (document.file_name ?? "Ongetiteld document")
          : "Ongetitelde vergadering"),
      summary: snippetHtml
        ? snippetHtml.replaceAll(/<\/?b>/g, "")
        : summarizeContent(document.content),
      summaryHtml: snippetHtml,
      downloadUrl: document.payload?.media_urls?.[0]?.url ?? document.payload?.original_url,
    };
  });

  const filteredResults = filterResultsByDateRange(results, { dateFrom, dateTo });

  const sortedResults = sortResults(filteredResults, sort);
  const pagedResults = sortedResults.slice(offset, offset + limit);

  return {
    results: pagedResults,
    totalCount: response.num_hits,
    totalIsApproximate: true,
    hasMore: sortedResults.length > offset + limit || response.num_hits > offset + limit,
  };
}

export async function getEntityContent(entityId: string): Promise<EntityContentResponse | null> {
  const quickwit = new QuickwitClient();
  const response = await quickwit.search(`entity_id:${escapeTerm(entityId)}`, 8);
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

  let markdownText = hit.payload?.md_text?.join("\n\n");
  const markdownKey = hit.payload?.derived_content?.markdown_key;

  if (!markdownText && markdownKey) {
    const storage = await ObjectStorageClient.fromEnvironment();
    markdownText = await storage.getObjectText(markdownKey);
  }

  return {
    entityId: hit.entity_id ?? entityId,
    entityType: hit.entity_type ?? "Unknown",
    markdownText,
    downloadUrl,
    contentType,
    pdfUrl,
  };
}
