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

async function extractPdf(bytes: Uint8Array): Promise<string> {
  const tempPath = await writeTempFile(bytes, ".pdf");
  try {
    return await readCommandOutput("/opt/homebrew/bin/pdftotext", [tempPath, "-"]);
  } finally {
    await Deno.remove(tempPath).catch(() => undefined);
  }
}

async function extractWithTextutil(bytes: Uint8Array, extension: string): Promise<string> {
  const tempPath = await writeTempFile(bytes, extension);
  try {
    return await readCommandOutput("/usr/bin/textutil", ["-convert", "txt", "-stdout", tempPath]);
  } finally {
    await Deno.remove(tempPath).catch(() => undefined);
  }
}

export async function extractDocumentText(
  bytes: Uint8Array,
  options: {
    contentType?: string;
    fileName?: string;
  } = {},
): Promise<string> {
  const contentType = options.contentType?.toLowerCase() ?? "";
  const extension = fileExtension(options.fileName);

  if (contentType.includes("pdf") || extension === ".pdf") {
    return normalizeWhitespace(await extractPdf(bytes));
  }

  if (
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
    return normalizeWhitespace(await extractWithTextutil(bytes, extension || ".docx"));
  }

  if (
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    extension === ".txt" ||
    extension === ".md" ||
    extension === ".json"
  ) {
    return normalizeWhitespace(new TextDecoder().decode(bytes));
  }

  return "";
}
