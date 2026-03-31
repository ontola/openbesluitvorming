import { extractText, getDocumentProxy } from "npm:unpdf";

export interface DocumentMarkdownExtractionResult {
  markdown: string;
  warnings: string[];
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

async function writeTempFile(bytes: Uint8Array, extension: string): Promise<string> {
  const path = await Deno.makeTempFile({ suffix: extension });
  await Deno.writeFile(path, bytes);
  return path;
}

async function readCommandOutput(command: string, args: string[]): Promise<string> {
  const process = new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await process.output();
  if (output.code !== 0) {
    const stderr = new TextDecoder().decode(output.stderr);
    throw new Error(`${command} failed: ${stderr.trim()}`);
  }

  return new TextDecoder().decode(output.stdout);
}

async function extractPdf(bytes: Uint8Array): Promise<DocumentMarkdownExtractionResult> {
  return await extractPdfMarkdown(bytes);
}

function unpdfBinary(): string {
  return Deno.env.get("WOOZI_UNPDF_BIN")?.trim() || "unpdf";
}

async function extractPdfMarkdownWithCli(bytes: Uint8Array): Promise<string> {
  const tempPath = await writeTempFile(bytes, ".pdf");
  try {
    return normalizeWhitespace(
      await readCommandOutput(unpdfBinary(), [
        "markdown",
        tempPath,
        "--cleanup",
        "standard",
        "--table-mode",
        "html",
      ]),
    );
  } finally {
    await Deno.remove(tempPath).catch(() => undefined);
  }
}

async function extractPdfMarkdownWithJsFallback(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes.slice());
  const { text } = await extractText(pdf, { mergePages: true });
  return deriveMarkdownFromText(normalizeWhitespace(text));
}

async function extractPdfMarkdown(bytes: Uint8Array): Promise<DocumentMarkdownExtractionResult> {
  try {
    return {
      markdown: await extractPdfMarkdownWithCli(bytes),
      warnings: [],
    };
  } catch (error) {
    if (isCommandMissing(error)) {
      // The Rust unpdf CLI is the preferred PDF->Markdown path. Keep this fallback so host-side
      // development and tests still work before the CLI is installed everywhere.
      return {
        markdown: await extractPdfMarkdownWithJsFallback(bytes),
        warnings: [
          `Rust unpdf CLI not found at '${unpdfBinary()}', falling back to JS PDF extraction.`,
        ],
      };
    }
    throw error;
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
  } else if (
    contentType.includes("word") ||
    contentType.includes("officedocument") ||
    contentType.includes("rtf") ||
    extension === ".doc" ||
    extension === ".docx" ||
    extension === ".rtf" ||
    extension === ".odt" ||
    extension === ".html" ||
    extension === ".htm"
  ) {
    if (extension === ".html" || extension === ".htm" || contentType.includes("html")) {
      text = normalizeWhitespace(new TextDecoder().decode(bytes));
    } else {
      warnings.push(
        `Office document extraction is not supported yet for ${extension || contentType || "this file type"}.`,
      );
    }
  } else if (
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
