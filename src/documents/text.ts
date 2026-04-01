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
  return {
    markdown: await extractPdfMarkdownWithCli(bytes),
    warnings: [],
  };
}

function transmutationBinary(): string {
  return Deno.env.get("WOOZI_TRANSMUTATION_BIN")?.trim() || "transmutation";
}

async function extractPdfMarkdownWithCli(bytes: Uint8Array): Promise<string> {
  const tempPath = await writeTempFile(bytes, ".pdf");
  const outputPath = await Deno.makeTempFile({ suffix: ".md" });
  try {
    await readCommandOutput(transmutationBinary(), [
      "convert",
      tempPath,
      "-o",
      outputPath,
      "--format",
      "markdown",
    ]);
    return normalizeWhitespace(await Deno.readTextFile(outputPath));
  } finally {
    await Deno.remove(tempPath).catch(() => undefined);
    await Deno.remove(outputPath).catch(() => undefined);
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
