import { assert, assertEquals } from "jsr:@std/assert";
import { belongsToSiteSibling, ibabsSiteSiblingLabels } from "../src/ibabs/shared_site.ts";
import { getIbabsSource } from "../src/sources/index.ts";

Deno.test("sources that share an iBabs site know each other", () => {
  assertEquals(ibabsSiteSiblingLabels(getIbabsSource("druten")), ["Wijchen"]);
  assertEquals(ibabsSiteSiblingLabels(getIbabsSource("wijchen")), ["Druten"]);
  assertEquals(ibabsSiteSiblingLabels(getIbabsSource("voorschoten")), ["Wassenaar"]);
  assertEquals(ibabsSiteSiblingLabels(getIbabsSource("amstelveen")), []);
});

Deno.test("a meeting type naming only the sibling belongs to the sibling (#339)", () => {
  // Meeting type names as they appear on the shared wdw site.
  assert(belongsToSiteSibling("College BenW publicatie Wijchen", "Druten", ["Wijchen"]));
  assert(belongsToSiteSibling("Raad openbaar Wijchen", "Druten", ["Wijchen"]));
  assert(!belongsToSiteSibling("College BenW publicatie Druten", "Druten", ["Wijchen"]));
  assert(belongsToSiteSibling("Rondetafelgesprek raad Druten", "Wijchen", ["Druten"]));
  assert(!belongsToSiteSibling("Gemeenteraad Voorschoten", "Voorschoten", ["Wassenaar"]));
});

Deno.test("a meeting that names neither or both stays with every organization on the site", () => {
  assert(!belongsToSiteSibling("Vergadering 2026-06-25T19:04:00", "Druten", ["Wijchen"]));
  assert(!belongsToSiteSibling("Gezamenlijke raad Druten en Wijchen", "Druten", ["Wijchen"]));
  assert(!belongsToSiteSibling(undefined, "Druten", ["Wijchen"]));
  assert(!belongsToSiteSibling("Raad openbaar Wijchen", "Amstelveen", []));
});

Deno.test("a sibling label only matches as a whole word", () => {
  assert(!belongsToSiteSibling("Wijchenseweg overleg", "Druten", ["Wijchen"]));
  assert(belongsToSiteSibling("raad wijchen", "Druten", ["Wijchen"]));
});
