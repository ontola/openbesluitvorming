import type { DocumentPageChunk } from "../types.ts";
export interface DocumentMarkdownExtractionResult {
  markdown: string;
  warnings: string[];
  pageChunks?: DocumentPageChunk[];
}

const TRANSMUTATION_MARKDOWN_EXTENSIONS = new Set([
  ".pdf",
  ".docx",
  ".pptx",
  ".xlsx",
  ".html",
  ".htm",
  ".xml",
  ".txt",
  ".md",
  ".rtf",
  ".odt",
]);

function pymupdf4llmBinary(): string | null {
  const value = Deno.env.get("WOOZI_PYMUPDF4LLM_BIN")?.trim();
  if (value) {
    return value;
  }

  for (const candidate of ["/usr/local/bin/pymupdf4llm_extract", "/app/scripts/pymupdf4llm_extract.sh"]) {
    try {
      Deno.statSync(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  return null;
}

function isCommandMissing(error: unknown): boolean {
  return (
    error instanceof Deno.errors.NotFound ||
    (error instanceof Error && error.message.includes("No such file or directory"))
  );
}

function normalizeWhitespace(text: string): string {
  return text
    .replaceAll(/\r\n/g, "\n")
    .replaceAll(/[ \t]+\n/g, "\n")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();
}

function fileExtension(fileName?: string): string {
  if (!fileName || !fileName.includes(".")) {
    return "";
  }

  return fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
}

async function readCommandOutput(command: string, args: string[]): Promise<string> {
  let output: Deno.CommandOutput;
  try {
    const process = new Deno.Command(command, {
      args,
      stdout: "piped",
      stderr: "piped",
    });
    output = await process.output();
  } catch (error) {
    if (isCommandMissing(error)) {
      throw new Error(`Rust transmutation CLI not found at '${transmutationBinary()}'.`);
    }
    throw error;
  }
  if (output.code !== 0) {
    const stderr = new TextDecoder().decode(output.stderr);
    const trimmed = stderr.trim();
    throw new Error(normalizeCliError(command, trimmed), { cause: trimmed });
  }

  return new TextDecoder().decode(output.stdout);
}

async function removePath(path: string): Promise<void> {
  await Deno.remove(path, { recursive: true }).catch(() => undefined);
}

function normalizeCliError(command: string, stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const combined = lines.join(" ");

  if (combined.includes("UnsupportedEncryption")) {
    return `${command} failed: PDF is encrypted or uses unsupported encryption`;
  }

  if (combined.includes("Failed to load PDF")) {
    return `${command} failed: PDF parser could not load this file`;
  }

  const panicLine = lines.find((line) => line.includes("panicked at"));
  if (panicLine) {
    const noteIndex = combined.indexOf("note:");
    const panicBody = noteIndex >= 0 ? combined.slice(0, noteIndex).trim() : combined;
    return `${command} failed: ${panicBody}`;
  }

  return `${command} failed: ${combined}`;
}

async function extractPdf(bytes: Uint8Array): Promise<DocumentMarkdownExtractionResult> {
  const pymupdfBin = pymupdf4llmBinary();

  if (pymupdfBin) {
    try {
      return await extractPdfWithPymupdf4llmCli(bytes, pymupdfBin);
    } catch {
      const fallback = await extractPdfWithTransmutation(bytes);
      return {
        markdown: fallback.markdown,
        pageChunks: fallback.pageChunks,
        warnings: [
          `pymupdf4llm PDF extraction failed; using transmutation fallback.`,
          ...fallback.warnings,
        ],
      };
    }
  }

  return await extractPdfWithTransmutation(bytes);
}

async function extractPdfWithTransmutation(bytes: Uint8Array): Promise<DocumentMarkdownExtractionResult> {
  try {
    const pageChunks = await extractPdfMarkdownPagesWithCli(bytes);
    return {
      markdown: normalizeWhitespace(pageChunks.map((page) => page.markdown).join("\n\n")),
      pageChunks,
      warnings: [],
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("no per-page markdown files were produced")
    ) {
      const fallback = await extractMarkdownWithCli(bytes, ".pdf");
      return {
        markdown: fallback.markdown,
        warnings: [
          ...fallback.warnings,
          "Per-page PDF extraction failed; using whole-document markdown fallback.",
        ],
      };
    }

    throw error;
  }
}

async function extractPdfWithPymupdf4llmCli(
  bytes: Uint8Array,
  command: string,
): Promise<DocumentMarkdownExtractionResult> {
  const workDir = await Deno.makeTempDir();
  const inputPath = `${workDir}/document.pdf`;
  const outputPath = `${workDir}/document.md`;
  await Deno.writeFile(inputPath, bytes);

  try {
    await readCommandOutput(command, [inputPath, outputPath]);
    const markdown = normalizeWhitespace(await Deno.readTextFile(outputPath));
    return {
      markdown,
      warnings: [],
    };
  } catch (error) {
    if (isCommandMissing(error)) {
      throw new Error(`PyMuPDF4LLM fallback CLI not found at '${command}'.`);
    }
    throw error;
  } finally {
    await removePath(workDir);
  }
}

async function extractMarkdownWithCli(
  bytes: Uint8Array,
  extension: string,
): Promise<DocumentMarkdownExtractionResult> {
  const workDir = await Deno.makeTempDir();
  const normalizedExtension = extension || ".bin";
  const inputPath = `${workDir}/document${normalizedExtension}`;
  const outputPath = `${workDir}/document.md`;
  await Deno.writeFile(inputPath, bytes);

  try {
    await readCommandOutput(transmutationBinary(), [
      "convert",
      inputPath,
      "--output",
      outputPath,
      "--format",
      "markdown",
    ]);

    const markdown = normalizeWhitespace(await Deno.readTextFile(outputPath));
    return {
      markdown,
      warnings: [],
    };
  } finally {
    await removePath(workDir);
  }
}

function transmutationBinary(): string {
  return Deno.env.get("WOOZI_TRANSMUTATION_BIN")?.trim() || "transmutation";
}

function parsePageNumber(path: string, fallbackPageNumber: number): number {
  const baseName = path.split("/").at(-1) ?? path;
  const zeroBasedSuffix = baseName.match(/_(\d+)\.md$/i);
  if (zeroBasedSuffix) {
    const parsed = Number(zeroBasedSuffix[1]);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed + 1;
    }
  }

  const matches = [...baseName.matchAll(/(\d+)/g)];
  const lastMatch = matches.at(-1)?.[1];
  const parsed = lastMatch ? Number(lastMatch) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackPageNumber;
}

async function collectMarkdownFiles(path: string): Promise<string[]> {
  const files: string[] = [];

  for await (const entry of Deno.readDir(path)) {
    const childPath = `${path}/${entry.name}`;
    if (entry.isDirectory) {
      files.push(...(await collectMarkdownFiles(childPath)));
      continue;
    }

    if (entry.isFile && childPath.toLowerCase().endsWith(".md")) {
      files.push(childPath);
    }
  }

  return files.sort((left, right) =>
    left.localeCompare(right, undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );
}

async function extractPdfMarkdownPagesWithCli(bytes: Uint8Array): Promise<DocumentPageChunk[]> {
  const workDir = await Deno.makeTempDir();
  const tempPath = `${workDir}/document.pdf`;
  await Deno.writeFile(tempPath, bytes);
  const outputDir = `${workDir}/pages`;
  await Deno.mkdir(outputDir, { recursive: true });
  try {
    await readCommandOutput(transmutationBinary(), [
      "convert",
      tempPath,
      "--output-dir",
      outputDir,
      "--format",
      "markdown",
      "--split-pages",
    ]);

    const markdownFilesInOutputDir = await collectMarkdownFiles(outputDir);
    const markdownFiles =
      markdownFilesInOutputDir.length > 0
        ? markdownFilesInOutputDir
        : (await collectMarkdownFiles(workDir)).filter((path) => !path.startsWith(`${outputDir}/`));
    if (markdownFiles.length === 0) {
      throw new Error("transmutation failed: no per-page markdown files were produced");
    }

    return await Promise.all(
      markdownFiles.map(async (path, index) => ({
        page_number: parsePageNumber(path, index + 1),
        markdown: normalizeWhitespace(await Deno.readTextFile(path)),
      })),
    );
  } finally {
    await removePath(workDir);
  }
}

export function deriveMarkdownFromText(text: string): string {
  if (!text.trim()) {
    return "";
  }

  const blocks = text
    .split(/\n{2,}/)
    .map((block) =>
      block
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    )
    .filter((lines) => lines.length > 0);

  return blocks
    .map((lines) => {
      if (lines.every((line) => /^(\d+([.)]|(\.\d+)+\.?)|[-*•])\s*/.test(line))) {
        return lines.join("\n");
      }

      if (
        lines.length === 1 &&
        lines[0].length <= 80 &&
        !/[.!?;:]$/.test(lines[0]) &&
        !/^\d+([.)]|(\.\d+)+\.?)?$/.test(lines[0])
      ) {
        return `## ${lines[0]}`;
      }

      return lines.join(" ");
    })
    .join("\n\n")
    .trim();
}

export async function extractDocumentMarkdown(
  bytes: Uint8Array,
  options: {
    contentType?: string;
    fileName?: string;
  } = {},
): Promise<DocumentMarkdownExtractionResult> {
  const contentType = options.contentType?.toLowerCase() ?? "";
  const extension = fileExtension(options.fileName);
  let text = "";
  const warnings: string[] = [];

  if (contentType.includes("pdf") || extension === ".pdf") {
    return await extractPdf(bytes);
  }

  const looksLikeTransmutationDocument =
    TRANSMUTATION_MARKDOWN_EXTENSIONS.has(extension) ||
    contentType.includes("word") ||
    contentType.includes("officedocument") ||
    contentType.includes("presentation") ||
    contentType.includes("spreadsheet") ||
    contentType.includes("excel") ||
    contentType.includes("powerpoint") ||
    contentType.includes("rtf") ||
    contentType.includes("opendocument") ||
    contentType.includes("html") ||
    contentType.includes("xml");

  if (looksLikeTransmutationDocument) {
    return await extractMarkdownWithCli(bytes, extension);
  }

  if (
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    extension === ".txt" ||
    extension === ".md" ||
    extension === ".json"
  ) {
    text = normalizeWhitespace(new TextDecoder().decode(bytes));
  }

  return {
    markdown: deriveMarkdownFromText(text),
    warnings,
  };
}
