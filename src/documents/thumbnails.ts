export function pdfPageCacheKey(entityId: string, pageNumber: number): string {
  return `pdf-pages-v4/${entityId}/${pageNumber}.jpg`;
}

export function pdfPageMetaKey(entityId: string): string {
  return `pdf-pages-v2/${entityId}/meta.json`;
}

const renderScriptPath = new URL("../../scripts/pdf_render_page.sh", import.meta.url).pathname;

export async function renderPdfPageJpeg(
  pdfBytes: Uint8Array,
  pageNumber: number,
): Promise<{
  imageBytes: Uint8Array;
  pageCount: number | null;
}> {
  const command = new Deno.Command("sh", {
    args: [renderScriptPath, String(pageNumber)],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const process = command.spawn();
  const writer = process.stdin.getWriter();
  await writer.write(pdfBytes);
  await writer.close();
  const result = await process.output();

  if (!result.success) {
    throw new Error(result.code === 1 ? "PDF page not found" : "PDF page could not be rendered");
  }

  const pageCount = parseInt(new TextDecoder().decode(result.stderr).trim(), 10);
  return {
    imageBytes: result.stdout,
    pageCount: Number.isNaN(pageCount) ? null : pageCount,
  };
}
