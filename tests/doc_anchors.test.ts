import { assertEquals } from "jsr:@std/assert";
import { slugifyHeading, withHeadingAnchors } from "../web/src/doc_anchors.ts";

Deno.test("a heading slug matches the anchors API.md already links to", () => {
  // These are the exact link targets written in API.md; if the slug rule
  // drifts, the in-page navigation silently stops resolving.
  assertEquals(slugifyHeading("Use case: voting data"), "use-case-voting-data");
  assertEquals(slugifyHeading("Use case: spoken word"), "use-case-spoken-word");
  assertEquals(slugifyHeading("Rate limits"), "rate-limits");
  assertEquals(slugifyHeading("PDF page rendering"), "pdf-page-rendering");
  assertEquals(slugifyHeading("Bulk export"), "bulk-export");
});

Deno.test("slugs survive the punctuation a Dutch heading carries", () => {
  assertEquals(slugifyHeading("Recept 4: Alleen documenten"), "recept-4-alleen-documenten");
  assertEquals(slugifyHeading("Wat is er veranderd?"), "wat-is-er-veranderd");
  // Two hyphens, not one: GitHub drops the dash but keeps both spaces, and a
  // link copied from GitHub has to keep working here.
  assertEquals(slugifyHeading("Zoeken — één organisatie"), "zoeken--één-organisatie");
  assertEquals(slugifyHeading("  Spaties  rondom  "), "spaties--rondom");
  assertEquals(slugifyHeading("!!!"), "");
});

Deno.test("every heading gets an id, and a repeat gets its own", () => {
  const html = withHeadingAnchors(
    "<h2>Use case: voting data</h2><h3>What to expect</h3>" +
      "<h2>Use case: spoken word</h2><h3>What to expect</h3>",
  );

  assertEquals(
    html,
    '<h2 id="use-case-voting-data">Use case: voting data</h2>' +
      '<h3 id="what-to-expect">What to expect</h3>' +
      '<h2 id="use-case-spoken-word">Use case: spoken word</h2>' +
      '<h3 id="what-to-expect-1">What to expect</h3>',
  );
});

Deno.test("inline markup inside a heading does not leak into its id", () => {
  assertEquals(
    withHeadingAnchors("<h3>The <code>motion</code> object</h3>"),
    '<h3 id="the-motion-object">The <code>motion</code> object</h3>',
  );
});

Deno.test("an id already present is left alone, and unheaded markup is untouched", () => {
  assertEquals(withHeadingAnchors('<h2 id="chosen">Titel</h2>'), '<h2 id="chosen">Titel</h2>');
  assertEquals(withHeadingAnchors("<p>Geen kop, geen id.</p>"), "<p>Geen kop, geen id.</p>");
  // A heading with no sluggable text keeps its shape rather than getting id="".
  assertEquals(withHeadingAnchors("<h2>???</h2>"), "<h2>???</h2>");
});
