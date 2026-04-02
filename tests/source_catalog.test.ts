import {
  getCatalogSourceByKey,
  getCatalogSourceByRef,
  listCatalogSources,
  listImplementedCatalogSources,
} from "../src/sources/catalog.ts";
import { listAggregateAdminSourceOptions, listAggregateRunnableSourceRefs } from "../src/sources/index.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

Deno.test("source catalog includes the full ORI inventory with unique source refs and keys", () => {
  const sources = listCatalogSources();
  const refs = new Set(sources.map((source) => source.sourceRef));
  const keys = new Set(sources.map((source) => source.key));

  assert(sources.length === 330, "expected the full ORI source inventory");
  assert(refs.size === sources.length, "sourceRef must be unique across all imported ORI sources");
  assert(keys.size === sources.length, "key must be globally unique across the source catalog");
  assert(
    getCatalogSourceByRef("notubiz:gemeente:haarlem").allmanakId === 38688,
    "expected Haarlem Notubiz source in the catalog",
  );
  assert(
    getCatalogSourceByKey("haarlem").sourceRef === "notubiz:gemeente:haarlem",
    "expected bare source key lookup to resolve uniquely",
  );
  assert(
    getCatalogSourceByRef("ibabs:provincie:noord-holland").ibabsSitename === "noord-holland",
    "expected Noord-Holland iBabs source in the catalog",
  );
  assert(
    getCatalogSourceByRef("gemeenteoplossingen:gemeente:goirle").baseUrl?.length,
    "expected gemeenteoplossingen source metadata in the catalog",
  );
  assert(
    getCatalogSourceByRef("parlaeus:gemeente:bodegravenreeuwijk").sessionId?.length,
    "expected parlaeus source metadata in the catalog",
  );
});

Deno.test("implemented catalog sources are limited to Woozi-supported suppliers for now", () => {
  const sources = listImplementedCatalogSources();
  const suppliers = new Set(sources.map((source) => source.supplier));

  assert(sources.length === 292, "expected current implemented supplier inventory");
  assert(
    suppliers.size === 2 && suppliers.has("notubiz") && suppliers.has("ibabs"),
    "only notubiz and ibabs should be marked implemented for now",
  );
});

Deno.test("aggregate runnable sources include all implemented sources for a supplier", () => {
  const refs = listAggregateRunnableSourceRefs("notubiz");
  const implementedNotubizRefs = listImplementedCatalogSources()
    .filter((source) => source.supplier === "notubiz")
    .map((source) => source.sourceRef);

  assert(refs.length > 0, "aggregate import should still have runnable sources");
  assert(
    refs.every((ref) => ref.startsWith("notubiz:")),
    "aggregate import should currently exclude ibabs sources",
  );
  assert(
    JSON.stringify(refs) === JSON.stringify(implementedNotubizRefs),
    "aggregate import should not silently drop implemented notubiz sources",
  );
});

Deno.test("admin source options expose supplier aggregate choices", () => {
  const options = listAggregateAdminSourceOptions();
  const refs = options.map((option) => option.sourceRef);

  assert(refs.includes("__supplier__:notubiz"), "expected aggregate notubiz option");
  assert(refs.includes("__supplier__:ibabs"), "expected aggregate ibabs option");
  assert(
    options.every((option) => option.isAggregate),
    "aggregate source options should be marked as aggregate",
  );
});
