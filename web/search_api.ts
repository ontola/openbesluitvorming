import { QuickwitClient } from "../src/quickwit/client.ts";

type SearchHit = {
  name?: string;
  organization?: string;
  start_date?: string;
  content?: string;
  source_key?: string;
};

export type SearchResult = {
  organization: string;
  date: string;
  title: string;
  summary: string;
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

function buildQuickwitQuery(query: string, organization: string): string {
  const parts = ["entity_type:Meeting"];

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
    haarlem: "Gemeente Haarlem",
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
  } = {},
): Promise<SearchResult[]> {
  const query = options.query?.trim() ?? "";
  const organization = options.organization?.trim() ?? "";
  const quickwit = new QuickwitClient();
  const response = await quickwit.search(buildQuickwitQuery(query, organization), 12);

  return response.hits.map((hit) => {
    const document = hit as SearchHit;

    return {
      organization: displayOrganization(document),
      date: formatDate(document.start_date),
      title: document.name ?? "Ongetitelde vergadering",
      summary: document.content ?? "Geen samenvatting beschikbaar.",
    };
  });
}
