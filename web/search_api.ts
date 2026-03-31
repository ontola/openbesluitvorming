import type { SearchResult } from "../src/types.ts";
import { QuickwitClient } from "../src/quickwit/client.ts";

type SearchHit = {
  entity_type?: string;
  name?: string;
  organization?: string;
  start_date?: string;
  content?: string;
  file_name?: string;
  source_key?: string;
  payload?: {
    original_url?: string;
    text?: string[];
    media_urls?: Array<{
      url?: string;
    }>;
  };
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
  const response = await quickwit.search(buildQuickwitQuery(query, organization, entityType), 24);

  const results = response.hits.map((hit) => {
    const document = hit as SearchHit;

    return {
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
      summary: summarizeContent(document.content),
      fullText:
        document.payload?.text?.join("\n\n") ??
        document.content ??
        "Geen platte tekst beschikbaar voor dit resultaat.",
      downloadUrl: document.payload?.media_urls?.[0]?.url ?? document.payload?.original_url,
    };
  });

  return sortResults(results, sort);
}
