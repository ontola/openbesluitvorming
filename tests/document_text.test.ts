import { deriveMarkdownFromText, extractDocumentMarkdown } from "../src/documents/text.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

Deno.test("extractDocumentMarkdown warns explicitly for unsupported office formats", async () => {
  const result = await extractDocumentMarkdown(new TextEncoder().encode("dummy"), {
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    fileName: "nota.docx",
  });

  assert(result.markdown === "", "unsupported office documents should not invent markdown");
  assert(
    result.warnings[0]?.includes("Office document extraction is not supported yet"),
    "unsupported office documents should emit a clear warning",
  );
});

Deno.test("extractDocumentMarkdown decodes html without external tools", async () => {
  const result = await extractDocumentMarkdown(
    new TextEncoder().encode("<h1>Agenda</h1><p>Besluitvorming</p>"),
    {
      contentType: "text/html",
      fileName: "agenda.html",
    },
  );

  assert(
    result.markdown.includes("<h1>Agenda</h1><p>Besluitvorming</p>"),
    "html documents should be decoded directly instead of shelling out",
  );
});

Deno.test("extractDocumentMarkdown propagates non-missing unpdf failures", async () => {
  const tempScript = await Deno.makeTempFile({ suffix: ".sh" });
  await Deno.writeTextFile(
    tempScript,
    "#!/bin/sh\nprintf 'PDF parsing error: broken xref' 1>&2\nexit 1\n",
  );
  await Deno.chmod(tempScript, 0o755);

  const previous = Deno.env.get("WOOZI_UNPDF_BIN");
  Deno.env.set("WOOZI_UNPDF_BIN", tempScript);

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
      Deno.env.delete("WOOZI_UNPDF_BIN");
    } else {
      Deno.env.set("WOOZI_UNPDF_BIN", previous);
    }
    await Deno.remove(tempScript).catch(() => undefined);
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
