/** The scales a page can be asked at. 1 is 96 dpi, a laptop screen, and what
 * the extraction service prewarms for page 1; 2 is 192 dpi for screens with
 * two or more device pixels per CSS pixel, phones above all. Anything else is
 * refused rather than rendered, so a URL cannot ask for a poster. */
export const PDF_PAGE_SCALES = [1, 2] as const;
export type PdfPageScale = (typeof PDF_PAGE_SCALES)[number];
export const PDF_PAGE_BASE_DPI = 96;

export function parsePdfPageScale(value: string | null): PdfPageScale | null {
  if (value === null || value === "") {
    return 1;
  }
  const parsed = Number(value);
  return (PDF_PAGE_SCALES as readonly number[]).includes(parsed) ? (parsed as PdfPageScale) : null;
}

/** Scale 1 keeps the key the extraction service prewarms page 1 under; the
 * others get their own, so a cached 96 dpi page is never served for a 192
 * dpi request or the other way round. */
export function pdfPageCacheKey(
  entityId: string,
  pageNumber: number,
  scale: PdfPageScale = 1,
): string {
  const suffix = scale === 1 ? "" : `@${scale}x`;
  return `pdf-pages-v4/${entityId}/${pageNumber}${suffix}.jpg`;
}

export function pdfPageMetaKey(entityId: string): string {
  return `pdf-pages-v2/${entityId}/meta.json`;
}

const renderScriptPath = new URL("../../scripts/pdf_render_page.sh", import.meta.url).pathname;

export async function renderPdfPageJpeg(
  pdfBytes: Uint8Array,
  pageNumber: number,
  scale: PdfPageScale = 1,
): Promise<{
  imageBytes: Uint8Array;
  pageCount: number | null;
}> {
  const command = new Deno.Command("sh", {
    args: [renderScriptPath, String(pageNumber), String(PDF_PAGE_BASE_DPI * scale)],
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
