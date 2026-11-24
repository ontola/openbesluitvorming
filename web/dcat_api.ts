/** The DCAT catalogue behind `GET /api/dcat`: one dcat:Dataset per
 * organization we import, with the bulk export, the change feed and the search
 * API as its distributions. Shaped after DCAT-AP-DONL, the profile
 * data.overheid.nl harvests, and kept to what DCAT-AP-NL 3.0 also asks for:
 * publishers are TOOI URIs, vocabularies are the EU authority tables where
 * DCAT-AP-NL 3.0 uses them.
 *
 * The graph is built once and serialised three ways (JSON-LD, Turtle,
 * RDF/XML) by hand: it is a flat list of nodes with IRIs and literals, no blank
 * nodes, which keeps each writer a page long and makes the three provably say
 * the same thing (tests/dcat_api.test.ts parses all three and compares).
 *
 * Nothing here queries the search index per request. Freshness comes from the
 * /api/status answer, which has its own ten-minute cache shared with that
 * endpoint; the change times come from the export log's segment table; the
 * start of each period is one aggregation a day. The rendered documents are
 * cached for ten minutes on top. */
import { DEFAULT_PUBLIC_BASE_URL } from "../src/exports/sitemap.ts";
import { getExportLog } from "../src/exports/log.ts";
import { listImplementedCatalogSources } from "../src/sources/catalog.ts";
import { SUPPLIER_LABELS } from "../src/sources/index.ts";
import { tooiOrganization } from "../src/sources/tooi.ts";
import type { SourceCatalogEntry, StatusResponse } from "../src/types.ts";
import { getSourceEarliestContentDates } from "./search_api.ts";
import { getStatus } from "./status_api.ts";

export const DCAT_PREFIXES = {
  dcat: "http://www.w3.org/ns/dcat#",
  dct: "http://purl.org/dc/terms/",
  foaf: "http://xmlns.com/foaf/0.1/",
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  vcard: "http://www.w3.org/2006/vcard/ns#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
} as const;

type Prefix = keyof typeof DCAT_PREFIXES;
/** A predicate or class as a prefixed name, e.g. "dct:title". */
type QName = `${Prefix}:${string}`;

export type DcatTerm =
  | { iri: string }
  | { value: string; lang?: string; datatype?: "xsd:date" | "xsd:dateTime" };

export interface DcatNode {
  id: string;
  types: QName[];
  properties: Array<[QName, DcatTerm]>;
}

/** The data are the public records of the organizations themselves; what
 * Openbesluitvorming.nl adds (the metadata, the structure, the extracted text)
 * is dedicated to the public domain. The URI is the CC0 entry of the
 * DCAT-AP-DONL licence list. Changing the licence is a one-line change here. */
export const DATA_LICENSE = "http://creativecommons.org/publicdomain/zero/1.0/deed.nl";

const RIGHTS_STATEMENT =
  "Openbesluitvorming.nl stelt de metadata, de structuur en de geëxtraheerde tekst beschikbaar " +
  "onder CC0 1.0. De documenten zelf zijn openbaar gemaakte overheidsinformatie van het " +
  "bestuursorgaan dat ze publiceert; elk document verwijst naar het origineel bij de bron. Dat " +
  "bestuursorgaan blijft verantwoordelijk voor de inhoud en voor een eventueel voorbehoud van " +
  "auteursrecht op afzonderlijke stukken.";

const EU = "http://publications.europa.eu/resource/authority";
const LANGUAGE_NL = `${EU}/language/NLD`;
const ACCESS_PUBLIC = `${EU}/access-right/PUBLIC`;
const FREQUENCY_DAILY = `${EU}/frequency/DAILY`;
const FILE_TYPE_JSON = `${EU}/file-type/JSON`;
const MEDIA_TYPE_JSON = "https://www.iana.org/assignments/media-types/application/json";
/** TaxonomieBeleidsagenda, the theme list DCAT-AP-DONL requires, and the EU
 * data theme DCAT-AP-NL 3.0 maps it to. */
const THEME_BESTUUR = "http://standaarden.overheid.nl/owms/terms/Bestuur";
const THEME_TAXONOMY = "http://standaarden.overheid.nl/owms/terms/TaxonomieBeleidsagenda";
const THEME_EU_GOVERNMENT = `${EU}/data-theme/GOVE`;
const CONTACT_URL = "https://github.com/ontola/openbesluitvorming/issues";
const PUBLISHER_CATALOG = "https://ontola.io/";

/** What the graph needs to know about one source beyond the catalog row. */
export interface DcatSourceFacts {
  /** Last time the change feed grew. */
  lastChangedAt?: string;
  /** Last time anything was written to the search index, or the last
   * successful import: used when the change feed has nothing yet. */
  lastActivityAt?: string;
  earliestContentDate?: string;
  latestPastContentDate?: string;
}

export function dcatCatalogUrl(baseUrl: string): string {
  return `${baseUrl}/api/dcat`;
}

const lit = (value: string, lang = "nl"): DcatTerm => ({ value, lang });
const plain = (value: string): DcatTerm => ({ value });
const iri = (value: string): DcatTerm => ({ iri: value });
const dateTime = (value: string): DcatTerm => ({ value, datatype: "xsd:dateTime" });
const date = (value: string): DcatTerm => ({ value: value.slice(0, 10), datatype: "xsd:date" });

function formatDutchDate(value: string): string {
  return new Intl.DateTimeFormat("nl-NL", { dateStyle: "long", timeZone: "UTC" }).format(
    new Date(value),
  );
}

/** "Gemeente Haarlem" as it reads inside a Dutch sentence: "de gemeente Haarlem". */
function inSentence(name: string): string {
  const match = name.match(/^(Gemeente|Provincie|Waterschap|Hoogheemraadschap) (.+)$/);
  if (!match) return name;
  const article = match[1] === "Gemeente" || match[1] === "Provincie" ? "de" : "het";
  return `${article} ${match[1].toLowerCase()} ${match[2]}`;
}

const KIND_KEYWORDS: Record<SourceCatalogEntry["organizationType"], string[]> = {
  gemeente: ["gemeenteraad", "raadsinformatie"],
  provincie: ["Provinciale Staten", "statensinformatie"],
  waterschap: ["algemeen bestuur", "waterschap"],
};

/** The catalog label of the main source for each CBS code. Amsterdam's
 * stadsdelen and Landgraaf's second supplier share a code with the source that
 * carries the gemeente's own name; that one has the shortest key. */
function municipalityLabels(sources: SourceCatalogEntry[]): Map<string, string> {
  const main = new Map<string, SourceCatalogEntry>();
  for (const source of sources) {
    if (source.organizationType !== "gemeente" || !source.cbsId) continue;
    const current = main.get(source.cbsId);
    if (!current || source.key.length < current.key.length) {
      main.set(source.cbsId, source);
    }
  }
  return new Map(
    [...main].map(([cbsId, source]) => [cbsId, source.label ?? source.key.replaceAll("_", " ")]),
  );
}

export function buildDcatGraph(options: {
  sources: SourceCatalogEntry[];
  facts: Map<string, DcatSourceFacts>;
  baseUrl: string;
  generatedAt: string;
}): DcatNode[] {
  const { sources, facts, baseUrl, generatedAt } = options;
  const catalogId = dcatCatalogUrl(baseUrl);
  const at = (fragment: string) => `${catalogId}#${fragment}`;
  const contactId = at("contact");
  const rightsId = at("rights");
  const serviceId = at("api");
  const labels = municipalityLabels(sources);

  const nodes: DcatNode[] = [];
  const publishers = new Map<string, DcatNode>();
  const datasetIds: string[] = [];
  let catalogModified: string | undefined;

  const ordered = [...sources].sort((left, right) => left.key.localeCompare(right.key, "nl"));
  for (const source of ordered) {
    const municipalityLabel = source.cbsId ? labels.get(source.cbsId) : undefined;
    const organization = tooiOrganization(source, municipalityLabel);
    if (!organization) {
      // A dataset without a publisher fails DCAT-AP-DONL validation outright,
      // and a guessed URI names the wrong body. The test suite fails on this.
      console.warn(`[dcat] no TOOI identifier for source "${source.key}", left out`);
      continue;
    }
    if (!publishers.has(organization.uri)) {
      publishers.set(organization.uri, {
        id: organization.uri,
        types: ["foaf:Organization"],
        properties: [["foaf:name", lit(organization.name)]],
      });
    }

    const label = source.label ?? source.key.replaceAll("_", " ");
    const mainLabel = source.organizationType === "gemeente" ? municipalityLabel : undefined;
    const subdivision = mainLabel !== undefined && label !== mainLabel ? label : undefined;
    const subject = subdivision ? `${subdivision} (${organization.name})` : organization.name;
    const supplier = SUPPLIER_LABELS[source.supplier] ?? source.supplier;
    const sourceFacts = facts.get(source.key) ?? {};

    const descriptionParts = [
      `Vergaderingen, agendapunten, vergaderstukken, besluiten, moties en amendementen van ${
        subdivision
          ? `${subdivision}, onderdeel van ${inSentence(organization.name)}`
          : inSentence(organization.name)
      }, ` +
        `zoals gepubliceerd in het vergadersysteem ${supplier}, en waar beschikbaar de video- en ` +
        `audioregistraties met hun transcript.`,
      `Openbesluitvorming.nl haalt ze dagelijks op en maakt de tekst doorzoekbaar; elk stuk ` +
        `verwijst naar het origineel bij de bron.`,
    ];
    if (source.discontinuedAt) {
      descriptionParts.push(
        `${organization.name} is per ${formatDutchDate(source.discontinuedAt)} opgeheven bij een ` +
          `herindeling; er komen geen nieuwe stukken meer bij.`,
      );
    }

    const datasetId = at(source.key);
    datasetIds.push(datasetId);
    const encodedKey = encodeURIComponent(source.key);
    const snapshotUrl = `${baseUrl}/api/export/snapshot?source=${encodedKey}`;
    const changesUrl = `${baseUrl}/api/export/changes?source=${encodedKey}`;
    const searchUrl = `${baseUrl}/api/search?organization=${encodedKey}`;
    const docs = `${baseUrl}/docs/api`;

    const modified = sourceFacts.lastChangedAt ?? sourceFacts.lastActivityAt;
    if (modified && (!catalogModified || modified > catalogModified)) {
      catalogModified = modified;
    }

    const properties: DcatNode["properties"] = [
      ["dct:identifier", plain(datasetId)],
      ["dct:title", lit(`Besluitvorming ${subject}`)],
      ["dct:description", lit(descriptionParts.join(" "))],
      ["dct:publisher", iri(organization.uri)],
      ["dct:creator", iri(organization.uri)],
      ["dct:spatial", iri(organization.uri)],
      ["dcat:contactPoint", iri(contactId)],
      ["dcat:theme", iri(THEME_BESTUUR)],
      ["dcat:theme", iri(THEME_EU_GOVERNMENT)],
      ...[
        "besluitvorming",
        "vergaderingen",
        "moties",
        ...KIND_KEYWORDS[source.organizationType],
      ].map((keyword): [QName, DcatTerm] => ["dcat:keyword", lit(keyword)]),
      ["dct:language", iri(LANGUAGE_NL)],
      ["dct:license", iri(DATA_LICENSE)],
      ["dct:rights", iri(rightsId)],
      ["dct:accessRights", iri(ACCESS_PUBLIC)],
      ["dct:accrualPeriodicity", iri(FREQUENCY_DAILY)],
      ["dcat:landingPage", iri(`${baseUrl}/?organization=${encodedKey}`)],
      ["foaf:page", iri(docs)],
    ];
    if (modified) {
      properties.push(["dct:modified", dateTime(modified)]);
    }
    if (sourceFacts.earliestContentDate || sourceFacts.latestPastContentDate) {
      const periodId = at(`${source.key}-period`);
      properties.push(["dct:temporal", iri(periodId)]);
      const period: DcatNode = { id: periodId, types: ["dct:PeriodOfTime"], properties: [] };
      if (sourceFacts.earliestContentDate) {
        period.properties.push(["dcat:startDate", date(sourceFacts.earliestContentDate)]);
      }
      if (sourceFacts.latestPastContentDate) {
        period.properties.push(["dcat:endDate", date(sourceFacts.latestPastContentDate)]);
      }
      nodes.push(period);
    }

    const distributions: DcatNode[] = [
      {
        id: at(`${source.key}-snapshot`),
        types: ["dcat:Distribution"],
        properties: [
          ["dct:title", lit(`Bulkexport ${subject}`)],
          [
            "dct:description",
            lit(
              "De actuele stand van alle vergaderingen, documenten en moties van deze bron, als " +
                "NDJSON (één JSON-record per regel), per pagina van maximaal 1000 records. Volg " +
                "X-Next-Cursor tot X-Has-More false is.",
            ),
          ],
          ["dcat:accessURL", iri(snapshotUrl)],
          ["dcat:downloadURL", iri(snapshotUrl)],
          ["dct:format", iri(FILE_TYPE_JSON)],
          ["dct:license", iri(DATA_LICENSE)],
          ["dct:language", iri(LANGUAGE_NL)],
          ["foaf:page", iri(`${baseUrl}/docs/api#bulk-export`)],
        ],
      },
      {
        id: at(`${source.key}-changes`),
        types: ["dcat:Distribution"],
        properties: [
          ["dct:title", lit(`Wijzigingsfeed ${subject}`)],
          [
            "dct:description",
            lit(
              "Elke toevoeging, wijziging en verwijdering bij deze bron in volgorde, als NDJSON, " +
                "vanaf een cursor. Hiermee blijft een kopie van de bulkexport bij zonder alles " +
                "opnieuw op te halen.",
            ),
          ],
          ["dcat:accessURL", iri(changesUrl)],
          ["dcat:downloadURL", iri(changesUrl)],
          ["dct:format", iri(FILE_TYPE_JSON)],
          ["dct:license", iri(DATA_LICENSE)],
          ["dct:language", iri(LANGUAGE_NL)],
          ["foaf:page", iri(`${baseUrl}/docs/api#bulk-export`)],
        ],
      },
      {
        id: at(`${source.key}-search`),
        types: ["dcat:Distribution"],
        properties: [
          ["dct:title", lit(`Zoek-API ${subject}`)],
          [
            "dct:description",
            lit(
              "Zoeken in de vergaderingen, documenten, moties en registraties van deze bron, " +
                "met filters op type en datum. Antwoordt in JSON.",
            ),
          ],
          ["dcat:accessURL", iri(searchUrl)],
          ["dcat:accessService", iri(serviceId)],
          ["dct:format", iri(FILE_TYPE_JSON)],
          ["dcat:mediaType", iri(MEDIA_TYPE_JSON)],
          ["dct:license", iri(DATA_LICENSE)],
          ["dct:language", iri(LANGUAGE_NL)],
          ["foaf:page", iri(`${baseUrl}/docs/api#search`)],
        ],
      },
    ];
    for (const distribution of distributions) {
      properties.push(["dcat:distribution", iri(distribution.id)]);
    }
    nodes.push({ id: datasetId, types: ["dcat:Dataset"], properties }, ...distributions);
  }

  const catalog: DcatNode = {
    id: catalogId,
    types: ["dcat:Catalog"],
    properties: [
      ["dct:identifier", plain(catalogId)],
      ["dct:title", lit("Openbesluitvorming.nl")],
      [
        "dct:description",
        lit(
          "Open data over de besluitvorming van Nederlandse gemeenten, provincies en waterschappen. " +
            "Per bron één dataset met de vergaderingen, vergaderstukken, besluiten en moties van " +
            "dat bestuursorgaan, met als distributies de bulkexport, de wijzigingsfeed en de zoek-API.",
        ),
      ],
      ["dct:publisher", iri(PUBLISHER_CATALOG)],
      ["dct:creator", iri(PUBLISHER_CATALOG)],
      ["dcat:contactPoint", iri(contactId)],
      ["foaf:homepage", iri(`${baseUrl}/`)],
      ["dct:language", iri(LANGUAGE_NL)],
      ["dct:license", iri(DATA_LICENSE)],
      ["dct:rights", iri(rightsId)],
      ["dcat:theme", iri(THEME_BESTUUR)],
      ["dcat:themeTaxonomy", iri(THEME_TAXONOMY)],
      ["dct:modified", dateTime(catalogModified ?? generatedAt)],
      ["dcat:service", iri(serviceId)],
      ...datasetIds.map((id): [QName, DcatTerm] => ["dcat:dataset", iri(id)]),
    ],
  };

  const shared: DcatNode[] = [
    {
      id: PUBLISHER_CATALOG,
      types: ["foaf:Organization"],
      properties: [
        ["foaf:name", plain("Ontola")],
        ["foaf:homepage", iri(PUBLISHER_CATALOG)],
      ],
    },
    {
      id: contactId,
      types: ["vcard:Organization"],
      properties: [
        ["vcard:fn", plain("Openbesluitvorming.nl")],
        ["vcard:hasURL", iri(CONTACT_URL)],
      ],
    },
    {
      id: rightsId,
      types: ["dct:RightsStatement"],
      properties: [["rdfs:label", lit(RIGHTS_STATEMENT)]],
    },
    {
      id: serviceId,
      types: ["dcat:DataService"],
      properties: [
        ["dct:title", lit("Openbesluitvorming.nl API")],
        ["dcat:endpointURL", iri(`${baseUrl}/api/search`)],
        ["dcat:endpointDescription", iri(`${baseUrl}/docs/api`)],
        ["dct:license", iri(DATA_LICENSE)],
        ["dct:accessRights", iri(ACCESS_PUBLIC)],
        ["dct:publisher", iri(PUBLISHER_CATALOG)],
        ["dcat:contactPoint", iri(contactId)],
      ],
    },
  ];

  return [catalog, ...shared, ...publishers.values(), ...nodes];
}

// ---------------------------------------------------------------------------
// Serialisation

export type DcatFormat = "jsonld" | "turtle" | "rdfxml";

export const DCAT_CONTENT_TYPES: Record<DcatFormat, string> = {
  jsonld: "application/ld+json; charset=utf-8",
  turtle: "text/turtle; charset=utf-8",
  rdfxml: "application/rdf+xml; charset=utf-8",
};

const FORMAT_ALIASES: Record<string, DcatFormat> = {
  jsonld: "jsonld",
  "json-ld": "jsonld",
  json: "jsonld",
  ttl: "turtle",
  turtle: "turtle",
  rdf: "rdfxml",
  rdfxml: "rdfxml",
  xml: "rdfxml",
};

const ACCEPT_TYPES: Record<string, DcatFormat> = {
  "application/ld+json": "jsonld",
  "application/json": "jsonld",
  "text/turtle": "turtle",
  "application/x-turtle": "turtle",
  "application/rdf+xml": "rdfxml",
  "application/xml": "rdfxml",
  "text/xml": "rdfxml",
};

/** `format` wins over `Accept`. An unknown `format` is refused (null) rather
 * than answered in a different serialisation; an `Accept` header we cannot
 * serve gets JSON-LD, because harvesters routinely send `*\/*` or a list. */
export function negotiateDcatFormat(
  format: string | null,
  accept: string | null,
): DcatFormat | null {
  if (format !== null && format.trim() !== "") {
    return FORMAT_ALIASES[format.trim().toLowerCase()] ?? null;
  }
  const ranges = (accept ?? "")
    .split(",")
    .map((part, index) => {
      const [type, ...params] = part.trim().toLowerCase().split(";");
      const q = params.map((param) => param.trim()).find((param) => param.startsWith("q="));
      const weight = q ? Number(q.slice(2)) : 1;
      return { type: type.trim(), weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((range) => range.weight > 0 && ACCEPT_TYPES[range.type])
    .sort((left, right) => right.weight - left.weight || left.index - right.index);
  return ranges.length > 0 ? ACCEPT_TYPES[ranges[0].type] : "jsonld";
}

function expand(name: QName): string {
  const [prefix, local] = name.split(":") as [Prefix, string];
  return `${DCAT_PREFIXES[prefix]}${local}`;
}

export function toJsonLd(nodes: DcatNode[]): string {
  const graph = nodes.map((node) => {
    const out: Record<string, unknown> = { "@id": node.id, "@type": node.types };
    for (const [predicate, term] of node.properties) {
      const value =
        "iri" in term
          ? { "@id": term.iri }
          : term.datatype
            ? { "@value": term.value, "@type": term.datatype }
            : term.lang
              ? { "@value": term.value, "@language": term.lang }
              : term.value;
      const existing = out[predicate];
      if (existing === undefined) {
        out[predicate] = value;
      } else if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        out[predicate] = [existing, value];
      }
    }
    return out;
  });
  return JSON.stringify({ "@context": DCAT_PREFIXES, "@graph": graph });
}

function turtleString(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")}"`;
}

function turtleIri(value: string): string {
  // Characters an IRIREF may not hold; none of ours should, but a catalog key
  // is data and the encoder must not trust it.
  return `<${value.replace(/[\u0000- <>"{}|^`\\]/g, (char) => encodeURIComponent(char))}>`;
}

function turtleTerm(term: DcatTerm): string {
  if ("iri" in term) return turtleIri(term.iri);
  if (term.datatype) return `${turtleString(term.value)}^^${term.datatype}`;
  if (term.lang) return `${turtleString(term.value)}@${term.lang}`;
  return turtleString(term.value);
}

export function toTurtle(nodes: DcatNode[]): string {
  const lines = Object.entries(DCAT_PREFIXES).map(
    ([prefix, uri]) => `@prefix ${prefix}: <${uri}> .`,
  );
  for (const node of nodes) {
    lines.push("");
    const statements = [
      `a ${node.types.join(", ")}`,
      ...node.properties.map(([predicate, term]) => `${predicate} ${turtleTerm(term)}`),
    ];
    lines.push(`${turtleIri(node.id)}`);
    lines.push(
      statements
        .map((statement, index) => `  ${statement}${index === statements.length - 1 ? " ." : " ;"}`)
        .join("\n"),
    );
  }
  return `${lines.join("\n")}\n`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function toRdfXml(nodes: DcatNode[]): string {
  const namespaces = Object.entries(DCAT_PREFIXES)
    .map(([prefix, uri]) => `\n    xmlns:${prefix}="${uri}"`)
    .join("");
  const lines = [`<?xml version="1.0" encoding="UTF-8"?>`, `<rdf:RDF${namespaces}>`];
  for (const node of nodes) {
    lines.push(`  <rdf:Description rdf:about="${xmlEscape(node.id)}">`);
    for (const type of node.types) {
      lines.push(`    <rdf:type rdf:resource="${xmlEscape(expand(type))}"/>`);
    }
    for (const [predicate, term] of node.properties) {
      if ("iri" in term) {
        lines.push(`    <${predicate} rdf:resource="${xmlEscape(term.iri)}"/>`);
      } else if (term.datatype) {
        lines.push(
          `    <${predicate} rdf:datatype="${expand(term.datatype)}">${xmlEscape(term.value)}</${predicate}>`,
        );
      } else if (term.lang) {
        lines.push(
          `    <${predicate} xml:lang="${term.lang}">${xmlEscape(term.value)}</${predicate}>`,
        );
      } else {
        lines.push(`    <${predicate}>${xmlEscape(term.value)}</${predicate}>`);
      }
    }
    lines.push("  </rdf:Description>");
  }
  lines.push("</rdf:RDF>");
  return `${lines.join("\n")}\n`;
}

const SERIALIZERS: Record<DcatFormat, (nodes: DcatNode[]) => string> = {
  jsonld: toJsonLd,
  turtle: toTurtle,
  rdfxml: toRdfXml,
};

// ---------------------------------------------------------------------------
// Assembly and caching

const CACHE_TTL_MS = 10 * 60 * 1000;
/** The oldest content date only moves when a source is backfilled. */
const EARLIEST_TTL_MS = 24 * 60 * 60 * 1000;
/** After a failed aggregation, try again sooner than a day. */
const EARLIEST_RETRY_MS = 30 * 60 * 1000;

let earliestCache: { value: Map<string, string>; expiresAt: number } | null = null;

async function earliestContentDates(): Promise<Map<string, string>> {
  if (earliestCache && Date.now() < earliestCache.expiresAt) {
    return earliestCache.value;
  }
  try {
    const value = await getSourceEarliestContentDates();
    earliestCache = { value, expiresAt: Date.now() + EARLIEST_TTL_MS };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[dcat] earliest content dates unavailable: ${message}`);
    earliestCache = {
      value: earliestCache?.value ?? new Map(),
      expiresAt: Date.now() + EARLIEST_RETRY_MS,
    };
  }
  return earliestCache.value;
}

/** Each input is optional: a catalogue without dates is still a catalogue,
 * and a harvester that finds it gone is worse off than one that finds it a
 * little thin. */
async function collectFacts(): Promise<Map<string, DcatSourceFacts>> {
  let status: StatusResponse | null = null;
  try {
    status = await getStatus();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[dcat] status unavailable: ${message}`);
  }
  let lastChanges = new Map<string, string>();
  try {
    lastChanges = (await getExportLog()).lastChangeTimes();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[dcat] export log unavailable: ${message}`);
  }
  const earliest = await earliestContentDates();

  const facts = new Map<string, DcatSourceFacts>();
  for (const row of status?.sources ?? []) {
    facts.set(row.sourceKey, {
      lastActivityAt: row.lastIndexedAt ?? row.lastSuccessAt,
      latestPastContentDate: row.latestPastContentDate,
    });
  }
  for (const [sourceKey, changedAt] of lastChanges) {
    facts.set(sourceKey, { ...facts.get(sourceKey), lastChangedAt: changedAt });
  }
  for (const [sourceKey, earliestDate] of earliest) {
    facts.set(sourceKey, { ...facts.get(sourceKey), earliestContentDate: earliestDate });
  }
  return facts;
}

interface CachedCatalog {
  nodes: DcatNode[];
  rendered: Partial<Record<DcatFormat, string>>;
  expiresAt: number;
}

let cached: CachedCatalog | null = null;
let inFlight: Promise<CachedCatalog> | null = null;

async function computeCatalog(): Promise<CachedCatalog> {
  const facts = await collectFacts();
  const nodes = buildDcatGraph({
    sources: listImplementedCatalogSources(),
    facts,
    baseUrl: (Deno.env.get("WOOZI_PUBLIC_BASE_URL") ?? DEFAULT_PUBLIC_BASE_URL).replace(/\/$/, ""),
    generatedAt: new Date().toISOString(),
  });
  return { nodes, rendered: {}, expiresAt: Date.now() + CACHE_TTL_MS };
}

export async function getDcatCatalog(format: DcatFormat): Promise<string> {
  if (!cached || Date.now() >= cached.expiresAt) {
    inFlight ??= computeCatalog()
      .then((value) => {
        cached = value;
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    await inFlight;
  }
  const catalog = cached!;
  catalog.rendered[format] ??= SERIALIZERS[format](catalog.nodes);
  return catalog.rendered[format]!;
}
