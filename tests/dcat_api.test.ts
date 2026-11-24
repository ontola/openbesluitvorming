import { assert, assertEquals } from "jsr:@std/assert";
import { DatabaseSync } from "node:sqlite";
import { Parser as TurtleParser } from "npm:n3@1.26.0";
import jsonld from "npm:jsonld@8.3.3";
import { RdfXmlParser } from "npm:rdfxml-streaming-parser@3.1.0";
import { ExportChangesLog, type ExportSegmentStorage } from "../src/exports/log.ts";
import { listImplementedCatalogSources } from "../src/sources/catalog.ts";
import {
  buildDcatGraph,
  DATA_LICENSE,
  type DcatNode,
  type DcatSourceFacts,
  negotiateDcatFormat,
  toJsonLd,
  toRdfXml,
  toTurtle,
} from "../web/dcat_api.ts";

const BASE = "https://openbesluitvorming.nl";
const CATALOG = `${BASE}/api/dcat`;
const DCAT = "http://www.w3.org/ns/dcat#";
const DCT = "http://purl.org/dc/terms/";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

function build(facts = new Map<string, DcatSourceFacts>()): DcatNode[] {
  return buildDcatGraph({
    sources: listImplementedCatalogSources(),
    facts,
    baseUrl: BASE,
    generatedAt: "2026-11-24T12:00:00.000Z",
  });
}

function node(nodes: DcatNode[], id: string): DcatNode {
  const found = nodes.find((candidate) => candidate.id === id);
  assert(found, `expected a node ${id}`);
  return found;
}

function values(target: DcatNode, predicate: string): string[] {
  return target.properties
    .filter(([name]) => name === predicate)
    .map(([, term]) => ("iri" in term ? term.iri : term.value));
}

Deno.test("one dataset per implemented source, each in the catalog", () => {
  const nodes = build();
  const implemented = listImplementedCatalogSources();
  const datasets = nodes.filter((candidate) => candidate.types.includes("dcat:Dataset"));
  assertEquals(
    datasets.map((dataset) => dataset.id).sort(),
    implemented.map((source) => `${CATALOG}#${source.key}`).sort(),
    "a source without a dataset is missing a TOOI code (src/sources/tooi.ts)",
  );
  const catalog = node(nodes, CATALOG);
  assertEquals(values(catalog, "dcat:dataset").length, implemented.length);
  for (const source of implemented) {
    assert(/^[a-z0-9_-]+$/.test(source.key), `key "${source.key}" is safe in a fragment`);
  }
});

Deno.test("a source that is not implemented gets no dataset", () => {
  const nodes = build();
  // Gelderland is in the catalog but not imported.
  assert(!nodes.some((candidate) => candidate.id === `${CATALOG}#gelderland`));
});

Deno.test("every dataset carries the mandatory DCAT-AP-DONL properties", () => {
  const nodes = build();
  for (const dataset of nodes.filter((candidate) => candidate.types.includes("dcat:Dataset"))) {
    for (const predicate of [
      "dct:identifier",
      "dct:title",
      "dct:description",
      "dct:publisher",
      "dct:license",
      "dct:language",
      "dcat:contactPoint",
      "dcat:theme",
      "dct:accessRights",
      "dcat:landingPage",
    ]) {
      assert(values(dataset, predicate).length > 0, `${dataset.id} lacks ${predicate}`);
    }
    assertEquals(values(dataset, "dct:license"), [DATA_LICENSE]);
    const distributions = values(dataset, "dcat:distribution");
    assertEquals(distributions.length, 3, `${dataset.id} has the three distributions`);
    for (const id of distributions) {
      const distribution = node(nodes, id);
      for (const predicate of ["dcat:accessURL", "dct:format", "dct:title", "dct:license"]) {
        assert(values(distribution, predicate).length > 0, `${id} lacks ${predicate}`);
      }
    }
  }
});

Deno.test("publishers are TOOI URIs for a gemeente, a provincie and a waterschap", () => {
  const nodes = build();
  const publisher = (key: string) => values(node(nodes, `${CATALOG}#${key}`), "dct:publisher");
  assertEquals(publisher("haarlem"), ["https://identifier.overheid.nl/tooi/id/gemeente/gm0392"]);
  assertEquals(publisher("noord-holland"), [
    "https://identifier.overheid.nl/tooi/id/provincie/pv27",
  ]);
  // The catalog row says WS27, which is the CBS code; TOOI uses the waterschapscode.
  assertEquals(publisher("scheldestromen"), [
    "https://identifier.overheid.nl/tooi/id/waterschap/ws0661",
  ]);
  assertEquals(publisher("waterschap_amstel_gooi_en_vecht"), [
    "https://identifier.overheid.nl/tooi/id/waterschap/ws0155",
  ]);
  for (const dataset of nodes.filter((candidate) => candidate.types.includes("dcat:Dataset"))) {
    const [uri] = values(dataset, "dct:publisher");
    assert(
      /^https:\/\/identifier\.overheid\.nl\/tooi\/id\/(gemeente\/gm\d{4}|provincie\/pv\d{2}|waterschap\/ws\d{4})$/.test(
        uri,
      ),
      `${dataset.id} has publisher ${uri}`,
    );
  }
  assertEquals(
    values(node(nodes, "https://identifier.overheid.nl/tooi/id/gemeente/gm0392"), "foaf:name"),
    ["Gemeente Haarlem"],
  );
});

Deno.test("stadsdelen are published by the gemeente they belong to", () => {
  const nodes = build();
  const centrum = node(nodes, `${CATALOG}#amsterdam_centrum`);
  assertEquals(values(centrum, "dct:publisher"), [
    "https://identifier.overheid.nl/tooi/id/gemeente/gm0363",
  ]);
  assertEquals(values(centrum, "dct:title"), [
    "Besluitvorming Amsterdam Centrum (Gemeente Amsterdam)",
  ]);
  assertEquals(values(node(nodes, `${CATALOG}#amsterdam`), "dct:title"), [
    "Besluitvorming Gemeente Amsterdam",
  ]);
});

Deno.test("distributions point at the export and search endpoints for that source", () => {
  const nodes = build();
  assertEquals(values(node(nodes, `${CATALOG}#haarlem-snapshot`), "dcat:downloadURL"), [
    `${BASE}/api/export/snapshot?source=haarlem`,
  ]);
  assertEquals(values(node(nodes, `${CATALOG}#haarlem-changes`), "dcat:accessURL"), [
    `${BASE}/api/export/changes?source=haarlem`,
  ]);
  assertEquals(values(node(nodes, `${CATALOG}#haarlem-search`), "dcat:accessURL"), [
    `${BASE}/api/search?organization=haarlem`,
  ]);
});

Deno.test("modified prefers the change feed, and the period comes from the content dates", () => {
  const nodes = build(
    new Map([
      [
        "haarlem",
        {
          lastChangedAt: "2026-11-23T02:10:00.000Z",
          lastActivityAt: "2026-11-24T02:10:00.000Z",
          earliestContentDate: "2009-03-02T19:00:00.000Z",
          latestPastContentDate: "2026-11-20T19:30:00.000Z",
        },
      ],
      ["soest", { lastActivityAt: "2026-11-22T01:00:00.000Z" }],
    ]),
  );
  const haarlem = node(nodes, `${CATALOG}#haarlem`);
  assertEquals(values(haarlem, "dct:modified"), ["2026-11-23T02:10:00.000Z"]);
  const period = node(nodes, values(haarlem, "dct:temporal")[0]);
  assertEquals(values(period, "dcat:startDate"), ["2009-03-02"]);
  assertEquals(values(period, "dcat:endDate"), ["2026-11-20"]);
  assertEquals(values(node(nodes, `${CATALOG}#soest`), "dct:modified"), [
    "2026-11-22T01:00:00.000Z",
  ]);
  assertEquals(values(node(nodes, `${CATALOG}#alkmaar`), "dct:modified"), [], "unknown stays out");
  assertEquals(values(node(nodes, CATALOG), "dct:modified"), ["2026-11-23T02:10:00.000Z"]);
});

Deno.test("format comes from the parameter first, then from Accept, else JSON-LD", () => {
  assertEquals(negotiateDcatFormat("ttl", "application/rdf+xml"), "turtle");
  assertEquals(negotiateDcatFormat("rdfxml", null), "rdfxml");
  assertEquals(negotiateDcatFormat("jsonld", null), "jsonld");
  assertEquals(negotiateDcatFormat("csv", null), null);
  assertEquals(negotiateDcatFormat(null, "text/turtle"), "turtle");
  assertEquals(negotiateDcatFormat(null, "application/rdf+xml;q=0.9, text/turtle;q=0.5"), "rdfxml");
  assertEquals(negotiateDcatFormat(null, "text/html, */*;q=0.8"), "jsonld");
  assertEquals(negotiateDcatFormat(null, null), "jsonld");
});

type Quad = {
  subject: { value: string };
  predicate: { value: string };
  object: { termType: string; value: string; language?: string; datatype?: { value: string } };
};

function quadKey(quad: Quad): string {
  const object = quad.object;
  const literal =
    object.termType === "Literal"
      ? `"${object.value}"@${object.language ?? ""}^^${object.language ? "" : (object.datatype?.value ?? "")}`
      : `<${object.value}>`;
  return `<${quad.subject.value}> <${quad.predicate.value}> ${literal}`;
}

function normalizePlainLiteralType(key: string): string {
  // Parsers differ in whether a plain literal reports xsd:string.
  return key.replace(/\^\^http:\/\/www\.w3\.org\/2001\/XMLSchema#string$/, "^^");
}

function turtleQuads(text: string): Set<string> {
  return new Set(
    (new TurtleParser().parse(text) as Quad[]).map((quad) =>
      normalizePlainLiteralType(quadKey(quad)),
    ),
  );
}

function rdfXmlQuads(text: string): Promise<Set<string>> {
  return new Promise((resolve, reject) => {
    const keys = new Set<string>();
    const parser = new RdfXmlParser();
    parser.on("data", (quad: Quad) => keys.add(normalizePlainLiteralType(quadKey(quad))));
    parser.on("error", reject);
    parser.on("end", () => resolve(keys));
    parser.write(text);
    parser.end();
  });
}

async function jsonLdQuads(text: string): Promise<Set<string>> {
  const nquads = (await jsonld.toRDF(JSON.parse(text), {
    format: "application/n-quads",
  })) as string;
  return turtleQuads(nquads);
}

Deno.test("JSON-LD, Turtle and RDF/XML all parse and say the same thing", async () => {
  const nodes = build(
    new Map([
      [
        "haarlem",
        {
          lastChangedAt: "2026-11-23T02:10:00.000Z",
          earliestContentDate: "2009-03-02T19:00:00.000Z",
          latestPastContentDate: "2026-11-20T19:30:00.000Z",
        },
      ],
    ]),
  );
  const fromTurtle = turtleQuads(toTurtle(nodes));
  const fromRdfXml = await rdfXmlQuads(toRdfXml(nodes));
  const fromJsonLd = await jsonLdQuads(toJsonLd(nodes));

  assert(fromTurtle.size > 1000, `expected a sizeable graph, got ${fromTurtle.size} triples`);
  assertEquals([...fromRdfXml].sort(), [...fromTurtle].sort(), "RDF/XML matches Turtle");
  assertEquals([...fromJsonLd].sort(), [...fromTurtle].sort(), "JSON-LD matches Turtle");

  const datasetType = `<${CATALOG}#haarlem> <${RDF_TYPE}> <${DCAT}Dataset>`;
  assert(fromTurtle.has(datasetType), "Haarlem is typed dcat:Dataset");
  assert(
    fromTurtle.has(
      `<${CATALOG}#haarlem> <${DCT}modified> "2026-11-23T02:10:00.000Z"@^^http://www.w3.org/2001/XMLSchema#dateTime`,
    ),
    "modified keeps its datatype",
  );
});

class NoStorage implements ExportSegmentStorage {
  putObject(): Promise<unknown> {
    return Promise.resolve({});
  }
  getObjectText(): Promise<string> {
    return Promise.resolve("");
  }
}

Deno.test("the export log reports when each source's feed last grew", () => {
  const db = new DatabaseSync(":memory:");
  const log = new ExportChangesLog({ db, storage: new NoStorage() });
  db.prepare(
    `INSERT INTO export_segment (source_key, start_seq, end_seq, object_key, record_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("haarlem", 1, 10, "a", 10, "2026-11-01T00:00:00.000Z");
  db.prepare(
    `INSERT INTO export_segment (source_key, start_seq, end_seq, object_key, record_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("haarlem", 11, 20, "b", 10, "2026-11-20T00:00:00.000Z");
  db.prepare(`INSERT INTO export_pending (source_key, seq, record) VALUES (?, ?, ?)`).run(
    "soest",
    1,
    JSON.stringify({ time: "2026-11-23T00:00:00.000Z" }),
  );
  db.prepare(`INSERT INTO export_pending (source_key, seq, record) VALUES (?, ?, ?)`).run(
    "haarlem",
    21,
    JSON.stringify({ time: "2026-11-10T00:00:00.000Z" }),
  );
  const times = log.lastChangeTimes();
  assertEquals(times.get("haarlem"), "2026-11-20T00:00:00.000Z");
  assertEquals(times.get("soest"), "2026-11-23T00:00:00.000Z");
  assertEquals(times.size, 2);
});
