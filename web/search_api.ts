import type { EntityContentResponse, SearchResult } from "../src/types.ts";
import { QuickwitClient } from "../src/quickwit/client.ts";
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
  source_key?: string;
  payload?: {
    original_url?: string;
    media_urls?: Array<{
      url?: string;
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
  const labels: Record<string, string> = {
    alkmaar: "Gemeente Alkmaar",
    amsterdam: "Gemeente Amsterdam",
    amersfoort: "Gemeente Amersfoort",
    delft: "Gemeente Delft",
    haarlem: "Gemeente Haarlem",
    leiden: "Gemeente Leiden",
    zaanstad: "Gemeente Zaanstad",
  };

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

export async function searchMeetings(
  options: {
    query?: string;
    organization?: string;
    entityType?: string;
    sort?: string;
  } = {},
): Promise<SearchResult[]> {
  const query = options.query?.trim() ?? "";
  const organization = options.organization?.trim() ?? "";
  const entityType = options.entityType?.trim() ?? "";
  const sort = options.sort?.trim() ?? "date_desc";
  const quickwit = new QuickwitClient();
  const response = await quickwit.search(buildQuickwitQuery(query, organization, entityType), 96, {
    snippetFields: query ? ["content", "name"] : [],
  });

  const dedupedHits = dedupeLatestHits(response.hits as SearchHit[]);
  const snippetsByEntityId = new Map<string, SearchSnippet>();

  (response.hits as SearchHit[]).forEach((hit, index) => {
    if (!hit.entity_id || snippetsByEntityId.has(hit.entity_id)) {
      return;
    }
    const snippet = response.snippets?.[index] as SearchSnippet | undefined;
    if (snippet) {
      snippetsByEntityId.set(hit.entity_id, snippet);
    }
  });

  const results = dedupedHits.map((document) => {
    const snippets = document.entity_id ? snippetsByEntityId.get(document.entity_id) : undefined;
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

  return sortResults(results, sort).slice(0, 24);
}

export async function getEntityContent(entityId: string): Promise<EntityContentResponse | null> {
  const quickwit = new QuickwitClient();
  const response = await quickwit.search(`entity_id:${escapeTerm(entityId)}`, 8);
  const hit = dedupeLatestHits(response.hits as SearchHit[])[0];

  if (!hit) {
    return null;
  }

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
    downloadUrl: hit.payload?.media_urls?.[0]?.url ?? hit.payload?.original_url,
  };
}
