import { extractDocumentMarkdown } from "../src/documents/text.ts";

const FIXTURE_DIR = new URL("./fixtures/documents/", import.meta.url);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function withMockTransmutation(test: () => Promise<void>): Promise<void> {
  const scriptPath = await Deno.makeTempFile({ suffix: ".sh" });
  await Deno.writeTextFile(
    scriptPath,
    [
      "#!/bin/sh",
      'input=""',
      'output=""',
      'outdir=""',
      'if [ "$1" = "convert" ]; then',
      "  shift",
      "fi",
      'while [ "$#" -gt 0 ]; do',
      '  if [ -z "$input" ] && [ "${1#-}" = "$1" ]; then',
      '    input="$1"',
      "    shift",
      "    continue",
      "  fi",
      '  if [ "$1" = "--output" ] || [ "$1" = "-o" ]; then',
      '    output="$2"',
      "    shift 2",
      "    continue",
      "  fi",
      '  if [ "$1" = "--output-dir" ] || [ "$1" = "-d" ]; then',
      '    outdir="$2"',
      "    shift 2",
      "    continue",
      "  fi",
      "  shift",
      "done",
      'content=$(cat "$input")',
      'base=$(basename "$input")',
      "stem=${base%.*}",
      'dir=$(dirname "$input")',
      'case "$content" in',
      '  *"sample-good"*)',
      '    mkdir -p "$outdir"',
      '    printf "## Pagina 1\\n\\nEerste fixturepagina" > "$outdir/${stem}_0.md"',
      '    printf "## Pagina 2\\n\\nTweede fixturepagina" > "$outdir/${stem}_1.md"',
      "    ;;",
      '  *"sample-fallback"*)',
      '    if [ -n "$outdir" ]; then',
      "      :",
      "    else",
      '      printf "# Volledig document\\n\\nFallback markdown via whole-document conversie" > "$output"',
      "    fi",
      "    ;;",
      '  *"sample-docx"*)',
      '    printf "# DOCX fixture\\n\\nOmgezet via transmutation" > "$output"',
      "    ;;",
      "  *)",
      '    printf "unexpected fixture content: %s" "$content" 1>&2',
      "    exit 1",
      "    ;;",
      "esac",
    ].join("\n"),
  );
  await Deno.chmod(scriptPath, 0o755);

  const previous = Deno.env.get("WOOZI_TRANSMUTATION_BIN");
  Deno.env.set("WOOZI_TRANSMUTATION_BIN", scriptPath);

  try {
    await test();
  } finally {
    if (previous === undefined) {
      Deno.env.delete("WOOZI_TRANSMUTATION_BIN");
    } else {
      Deno.env.set("WOOZI_TRANSMUTATION_BIN", previous);
    }
    await Deno.remove(scriptPath).catch(() => undefined);
  }
}

Deno.test("fixture pdf with working split-pages returns page chunks", async () => {
  await withMockTransmutation(async () => {
    const bytes = await Deno.readFile(new URL("sample-good.pdf", FIXTURE_DIR));
    const result = await extractDocumentMarkdown(bytes, {
      contentType: "application/pdf",
      fileName: "sample-good.pdf",
    });

    assert(result.pageChunks?.length === 2, "expected split-page chunks for working fixture pdf");
    assert(result.pageChunks?.[0]?.page_number === 1, "expected first page to be page 1");
    assert(
      result.markdown.includes("Tweede fixturepagina"),
      "expected combined markdown to include later page content",
    );
    assert(result.warnings.length === 0, "working split-page extraction should not warn");
  });
});

Deno.test("fixture pdf falls back to whole-document markdown when split-pages output is absent", async () => {
  await withMockTransmutation(async () => {
    const bytes = await Deno.readFile(new URL("sample-fallback.pdf", FIXTURE_DIR));
    const result = await extractDocumentMarkdown(bytes, {
      contentType: "application/pdf",
      fileName: "sample-fallback.pdf",
    });

    assert(
      !result.pageChunks || result.pageChunks.length === 0,
      "fallback pdf should not claim page chunks",
    );
    assert(
      result.markdown.includes("Fallback markdown via whole-document conversie"),
      "expected fallback whole-document markdown to be returned",
    );
    assert(
      result.warnings.some((warning) => warning.includes("Per-page PDF extraction failed")),
      "expected a warning that page splitting degraded to full markdown",
    );
  });
});

Deno.test("fixture docx uses transmutation markdown path", async () => {
  await withMockTransmutation(async () => {
    const bytes = await Deno.readFile(new URL("sample.docx", FIXTURE_DIR));
    const result = await extractDocumentMarkdown(bytes, {
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      fileName: "sample.docx",
    });

    assert(
      result.markdown.includes("Omgezet via transmutation"),
      "expected docx fixture to be converted through transmutation",
    );
    assert(result.warnings.length === 0, "docx fixture should not warn");
  });
});
