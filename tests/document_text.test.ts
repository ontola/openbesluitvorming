import { deriveMarkdownFromText, extractDocumentMarkdown } from "../src/documents/text.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

Deno.test("extractDocumentMarkdown uses transmutation for supported office formats", async () => {
  const tempScript = await Deno.makeTempFile({ suffix: ".sh" });
  await Deno.writeTextFile(
    tempScript,
    [
      "#!/bin/sh",
      'input=""',
      'output=""',
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
      "  shift",
      "done",
      'if [ -z "$input" ] || [ -z "$output" ]; then',
      "  printf 'expected input file and --output' 1>&2",
      "  exit 1",
      "fi",
      "printf '# DOCX\\n\\nOmgezet via transmutation' > \"$output\"",
    ].join("\n"),
  );
  await Deno.chmod(tempScript, 0o755);

  const previous = Deno.env.get("WOOZI_TRANSMUTATION_BIN");
  Deno.env.set("WOOZI_TRANSMUTATION_BIN", tempScript);

  try {
    const result = await extractDocumentMarkdown(new TextEncoder().encode("dummy"), {
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      fileName: "nota.docx",
    });

    assert(
      result.markdown.includes("Omgezet via transmutation"),
      "supported office documents should be converted through transmutation",
    );
    assert(result.warnings.length === 0, "supported office documents should not warn");
  } finally {
    if (previous === undefined) {
      Deno.env.delete("WOOZI_TRANSMUTATION_BIN");
    } else {
      Deno.env.set("WOOZI_TRANSMUTATION_BIN", previous);
    }
    await Deno.remove(tempScript).catch(() => undefined);
  }
});

Deno.test("extractDocumentMarkdown leaves unknown binary formats alone", async () => {
  const result = await extractDocumentMarkdown(new Uint8Array([1, 2, 3, 4]), {
    contentType: "application/octet-stream",
    fileName: "blob.bin",
  });

  assert(result.markdown === "", "unknown binary files should not invent markdown");
  assert(result.warnings.length === 0, "unknown binary files should not emit fake warnings");
});

Deno.test("extractDocumentMarkdown returns per-page markdown chunks for PDFs", async () => {
  const tempScript = await Deno.makeTempFile({ suffix: ".sh" });
  await Deno.writeTextFile(
    tempScript,
    [
      "#!/bin/sh",
      'outdir=""',
      'if [ "$1" = "convert" ]; then',
      "  shift",
      "fi",
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "--output-dir" ] || [ "$1" = "-d" ]; then',
      '    outdir="$2"',
      "    shift 2",
      "    continue",
      "  fi",
      "  shift",
      "done",
      'if [ -z "$outdir" ]; then',
      "  printf 'expected --output-dir for split pages' 1>&2",
      "  exit 1",
      "fi",
      'mkdir -p "$outdir"',
      "printf '## Pagina 1\\n\\nEerste pagina' > \"$outdir/page-001.md\"",
      "printf '## Pagina 2\\n\\nTweede pagina' > \"$outdir/page-002.md\"",
    ].join("\n"),
  );
  await Deno.chmod(tempScript, 0o755);

  const previous = Deno.env.get("WOOZI_TRANSMUTATION_BIN");
  Deno.env.set("WOOZI_TRANSMUTATION_BIN", tempScript);

  try {
    const result = await extractDocumentMarkdown(new TextEncoder().encode("%PDF-1.4 pages"), {
      contentType: "application/pdf",
      fileName: "pages.pdf",
    });

    assert(result.markdown.includes("## Pagina 1"), "expected combined markdown from page chunks");
    assert(
      result.markdown.includes("## Pagina 2"),
      "expected later page markdown in combined output",
    );
    assert(result.pageChunks?.length === 2, "expected one chunk per emitted page");
    assert(
      result.pageChunks?.[1]?.page_number === 2,
      "expected page numbers to be parsed from file names",
    );
  } finally {
    if (previous === undefined) {
      Deno.env.delete("WOOZI_TRANSMUTATION_BIN");
    } else {
      Deno.env.set("WOOZI_TRANSMUTATION_BIN", previous);
    }
    await Deno.remove(tempScript).catch(() => undefined);
  }
});

Deno.test("extractDocumentMarkdown falls back to input-directory markdown output for single-page PDFs", async () => {
  const tempScript = await Deno.makeTempFile({ suffix: ".sh" });
  await Deno.writeTextFile(
    tempScript,
    [
      "#!/bin/sh",
      'input=""',
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
      '  if [ "$1" = "--output-dir" ] || [ "$1" = "-d" ]; then',
      '    outdir="$2"',
      "    shift 2",
      "    continue",
      "  fi",
      "  shift",
      "done",
      'if [ -z "$input" ] || [ -z "$outdir" ]; then',
      "  printf 'expected input file and --output-dir' 1>&2",
      "  exit 1",
      "fi",
      'input_dir=$(dirname "$input")',
      'input_base=$(basename "$input" .pdf)',
      "printf '# Enkel\\n\\nPagina tekst' > \"$input_dir/$input_base.md\"",
    ].join("\n"),
  );
  await Deno.chmod(tempScript, 0o755);

  const previous = Deno.env.get("WOOZI_TRANSMUTATION_BIN");
  Deno.env.set("WOOZI_TRANSMUTATION_BIN", tempScript);

  try {
    const result = await extractDocumentMarkdown(new TextEncoder().encode("%PDF-1.4 one page"), {
      contentType: "application/pdf",
      fileName: "single.pdf",
    });

    assert(result.pageChunks?.length === 1, "expected one chunk from input-directory markdown");
    assert(result.pageChunks?.[0]?.page_number === 1, "expected single-page fallback to be page 1");
    assert(
      result.markdown.includes("Pagina tekst"),
      "expected fallback markdown file content to be returned",
    );
  } finally {
    if (previous === undefined) {
      Deno.env.delete("WOOZI_TRANSMUTATION_BIN");
    } else {
      Deno.env.set("WOOZI_TRANSMUTATION_BIN", previous);
    }
    await Deno.remove(tempScript).catch(() => undefined);
  }
});

Deno.test("extractDocumentMarkdown uses transmutation for supported html formats", async () => {
  const tempScript = await Deno.makeTempFile({ suffix: ".sh" });
  await Deno.writeTextFile(
    tempScript,
    [
      "#!/bin/sh",
      'output=""',
      'if [ "$1" = "convert" ]; then',
      "  shift",
      "fi",
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "--output" ] || [ "$1" = "-o" ]; then',
      '    output="$2"',
      "    shift 2",
      "    continue",
      "  fi",
      "  shift",
      "done",
      'if [ -z "$output" ]; then',
      "  printf 'expected --output' 1>&2",
      "  exit 1",
      "fi",
      "printf '# HTML\\n\\nOmgezet uit HTML' > \"$output\"",
    ].join("\n"),
  );
  await Deno.chmod(tempScript, 0o755);

  const previous = Deno.env.get("WOOZI_TRANSMUTATION_BIN");
  Deno.env.set("WOOZI_TRANSMUTATION_BIN", tempScript);

  try {
    const result = await extractDocumentMarkdown(
      new TextEncoder().encode("<h1>Agenda</h1><p>Besluitvorming</p>"),
      {
        contentType: "text/html",
        fileName: "agenda.html",
      },
    );

    assert(
      result.markdown.includes("Omgezet uit HTML"),
      "html documents should go through transmutation when supported",
    );
  } finally {
    if (previous === undefined) {
      Deno.env.delete("WOOZI_TRANSMUTATION_BIN");
    } else {
      Deno.env.set("WOOZI_TRANSMUTATION_BIN", previous);
    }
    await Deno.remove(tempScript).catch(() => undefined);
  }
});

Deno.test("extractDocumentMarkdown propagates non-missing transmutation failures", async () => {
  const tempScript = await Deno.makeTempFile({ suffix: ".sh" });
  await Deno.writeTextFile(
    tempScript,
    "#!/bin/sh\nprintf 'PDF parsing error: broken xref' 1>&2\nexit 1\n",
  );
  await Deno.chmod(tempScript, 0o755);

  const previous = Deno.env.get("WOOZI_TRANSMUTATION_BIN");
  Deno.env.set("WOOZI_TRANSMUTATION_BIN", tempScript);

  try {
    let thrown: unknown;
    try {
      await extractDocumentMarkdown(new TextEncoder().encode("%PDF-1.4 invalid"), {
        contentType: "application/pdf",
        fileName: "broken.pdf",
      });
    } catch (error) {
      thrown = error;
    }

    assert(thrown instanceof Error, "expected CLI extraction failure to be thrown");
    assert(
      thrown.message.includes("PDF parsing error: broken xref"),
      "expected CLI stderr to surface in the error",
    );
  } finally {
    if (previous === undefined) {
      Deno.env.delete("WOOZI_TRANSMUTATION_BIN");
    } else {
      Deno.env.set("WOOZI_TRANSMUTATION_BIN", previous);
    }
    await Deno.remove(tempScript).catch(() => undefined);
  }
});

Deno.test("extractDocumentMarkdown normalizes unsupported encrypted PDF failures", async () => {
  const tempScript = await Deno.makeTempFile({ suffix: ".sh" });
  await Deno.writeTextFile(
    tempScript,
    "#!/bin/sh\nprintf 'Error: Engine error (PDF Parser): pdf-extract failed: PdfError(Decryption(UnsupportedEncryption))' 1>&2\nexit 1\n",
  );
  await Deno.chmod(tempScript, 0o755);

  const previous = Deno.env.get("WOOZI_TRANSMUTATION_BIN");
  Deno.env.set("WOOZI_TRANSMUTATION_BIN", tempScript);

  try {
    let thrown: unknown;
    try {
      await extractDocumentMarkdown(new TextEncoder().encode("%PDF-1.4 encrypted"), {
        contentType: "application/pdf",
        fileName: "encrypted.pdf",
      });
    } catch (error) {
      thrown = error;
    }

    assert(thrown instanceof Error, "expected encrypted PDF extraction to throw");
    assert(
      thrown.message.includes("PDF is encrypted or uses unsupported encryption"),
      "expected encrypted PDF failures to be normalized",
    );
  } finally {
    if (previous === undefined) {
      Deno.env.delete("WOOZI_TRANSMUTATION_BIN");
    } else {
      Deno.env.set("WOOZI_TRANSMUTATION_BIN", previous);
    }
    await Deno.remove(tempScript).catch(() => undefined);
  }
});

Deno.test("extractDocumentMarkdown surfaces a clear error when transmutation is missing", async () => {
  const previous = Deno.env.get("WOOZI_TRANSMUTATION_BIN");
  Deno.env.set("WOOZI_TRANSMUTATION_BIN", "/tmp/woozi-missing-transmutation-bin");

  try {
    let thrown: unknown;
    try {
      await extractDocumentMarkdown(new TextEncoder().encode("%PDF-1.4 missing"), {
        contentType: "application/pdf",
        fileName: "missing.pdf",
      });
    } catch (error) {
      thrown = error;
    }

    assert(thrown instanceof Error, "expected missing transmutation binary to throw");
    assert(
      thrown.message.includes("Rust transmutation CLI not found"),
      "expected a clear missing-transmutation error message",
    );
  } finally {
    if (previous === undefined) {
      Deno.env.delete("WOOZI_TRANSMUTATION_BIN");
    } else {
      Deno.env.set("WOOZI_TRANSMUTATION_BIN", previous);
    }
  }
});

Deno.test("deriveMarkdownFromText preserves simple headings and list blocks", () => {
  const markdown = deriveMarkdownFromText("Agenda\n\n- punt 1\n- punt 2\n\nBesluitvorming");

  assert(markdown.includes("## Agenda"), "single heading lines should become markdown headings");
  assert(markdown.includes("- punt 1\n- punt 2"), "list-like blocks should stay line-based");
  assert(
    markdown.includes("## Besluitvorming"),
    "later heading-like blocks should also become markdown headings",
  );
});
