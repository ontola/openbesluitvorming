import { extractDocumentMarkdown } from "../src/documents/text.ts";
import { assessMarkdownQuality } from "../src/documents/quality.ts";

type LiveDocumentRegression = {
  id: string;
  label: string;
  url: string;
  fileName: string;
  contentType: string;
  expectedQuality: "good" | "suspect";
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const LIVE_FIXTURE_MANIFEST = new URL("./fixtures/live_document_regressions.json", import.meta.url);
const ENABLED = Deno.env.get("WOOZI_RUN_LIVE_DOCUMENT_REGRESSIONS") === "1";

const fixtures = JSON.parse(
  await Deno.readTextFile(LIVE_FIXTURE_MANIFEST),
) as LiveDocumentRegression[];

for (const fixture of fixtures) {
  Deno.test({
    name: `live document regression: ${fixture.label}`,
    ignore: !ENABLED,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const response = await fetch(fixture.url);
      assert(response.ok, `expected fixture download to succeed, got ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());

      const extraction = await extractDocumentMarkdown(bytes, {
        contentType: fixture.contentType,
        fileName: fixture.fileName,
      });
      const assessment = assessMarkdownQuality(extraction.markdown);

      assert(
        extraction.markdown.trim().length > 0,
        "expected live fixture extraction to return markdown text",
      );
      assert(
        assessment.status === fixture.expectedQuality,
        `expected ${fixture.expectedQuality} quality, got ${assessment.status} (score=${assessment.score})`,
      );

      console.log(JSON.stringify({
        id: fixture.id,
        label: fixture.label,
        expectedQuality: fixture.expectedQuality,
        actualQuality: assessment.status,
        score: assessment.score,
        warnings: extraction.warnings,
        preview: extraction.markdown.slice(0, 220),
      }, null, 2));
    },
  });
}
