import { renderSupplierText } from "../web/src/markdown.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

Deno.test("plain supplier text with markdown links becomes clickable, and safe", () => {
  // #295: Harderwijk's agenda text, as iBabs delivers it.
  const html = renderSupplierText(
    "De vergadering is te volgen via [www.harderwijk.nl/vergaderingen](https://www.harderwijk.nl/vergaderingen).&#xD;\n&#xD;\nProces: <script>alert(1)</script> is geen markup.",
  );
  assert(
    html.includes(
      '<a href="https://www.harderwijk.nl/vergaderingen">www.harderwijk.nl/vergaderingen</a>',
    ),
    `the markdown link is rendered, got ${html}`,
  );
  assert(!html.includes("&#xD;") && !html.includes("\r"), "carriage-return entities are dropped");
  assert(!html.includes("<script>"), "angle brackets in supplier text never become tags");
  assert(html.includes("&lt;script&gt;"), "they are shown as text instead");
});

Deno.test("supplier HTML is passed through as before", () => {
  const html = "<p>Vergadering in de <b>raadzaal</b>.</p>";
  assert(renderSupplierText(html) === html, "HTML from Notubiz keeps its markup");
  assert(
    renderSupplierText("") === "" && renderSupplierText(undefined) === "",
    "empty stays empty",
  );
});
