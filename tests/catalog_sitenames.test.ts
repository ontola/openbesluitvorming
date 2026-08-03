import { listSources } from "../src/sources/index.ts";
import type { IbabsSourceDefinition } from "../src/types.ts";

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}:\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`,
    );
  }
}

/** iBabs sitenames that genuinely serve more than one of our sources.
 *
 * Dutch bodies do share an iBabs tenant — merged municipalities and joint
 * organisations — so sharing is not wrong by itself. It is only ever correct
 * on purpose, which is what this list records.
 *
 * A sitename that shows up shared without being listed here is almost always a
 * copy-paste in the catalog, and the damage is quiet: both sources import the
 * same site, so one body's data is filed under another's name while its own
 * data is never fetched at all. `waterschap_limburg` pointed at `limburg`
 * (the province) for long enough to put ~100k provincial entities in the index
 * labelled as water board, and the actual water board was never imported. */
const INTENTIONALLY_SHARED: Record<string, string[]> = {
  // Merged into Land van Cuijk; the shared site keeps serving all three.
  CuijkGraveMill: ["cuijk", "grave", "mill_en_st_hubert"],
  // Werkorganisatie Druten-Wijchen.
  wdw: ["druten", "wijchen"],
  // Werkorganisatie Duivenvoorde.
  Duivenvoorde: ["voorschoten", "wassenaar"],
};

Deno.test("iBabs sitenames are only shared where we meant them to be", () => {
  const bySitename = new Map<string, string[]>();
  for (const source of listSources()) {
    if (source.supplier !== "ibabs") {
      continue;
    }
    const sitename = (source as IbabsSourceDefinition).ibabsSitename;
    if (!sitename) {
      continue;
    }
    bySitename.set(sitename, [...(bySitename.get(sitename) ?? []), source.key].sort());
  }

  const shared = Object.fromEntries(
    [...bySitename.entries()]
      .filter(([, keys]) => keys.length > 1)
      .map(([sitename, keys]) => [sitename, keys]),
  );

  const expected = Object.fromEntries(
    Object.entries(INTENTIONALLY_SHARED).map(([sitename, keys]) => [sitename, [...keys].sort()]),
  );

  assertEquals(
    shared,
    expected,
    "unexpected sitename sharing — a source is importing another body's site " +
      "(add it to INTENTIONALLY_SHARED only if the bodies really do share a tenant)",
  );
});

// listSources() already returns only the runnable (implemented) sources.
Deno.test("every runnable iBabs source names a site", () => {
  const missing = listSources()
    .filter((source) => source.supplier === "ibabs")
    .filter((source) => !(source as IbabsSourceDefinition).ibabsSitename?.trim())
    .map((source) => source.key);

  assertEquals(missing, [], "runnable iBabs sources without a sitename");
});
