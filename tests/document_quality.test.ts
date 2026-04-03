import { assessMarkdownQuality } from "../src/documents/quality.ts";
import { materializeDocument } from "../src/documents/process.ts";
import type { DocumentEntity } from "../src/types.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

class FakeStorage {
  private readonly objects = new Map<string, Uint8Array>();

  urlForKey(key: string): string {
    return `http://storage.test/woozi/${key}`;
  }

  async hasObject(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async putObject(key: string, body: Uint8Array): Promise<{ url: string }> {
    this.objects.set(key, body);
    return { url: this.urlForKey(key) };
  }

  async getObjectText(key: string): Promise<string> {
    const bytes = this.objects.get(key);
    return bytes ? new TextDecoder().decode(bytes) : "";
  }

  async getObjectBytes(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key) ?? null;
  }
}

function buildDocument(): DocumentEntity {
  return {
    id: "document:notubiz:gemeente:baarn:13165092",
    type: "Document",
    name: "Verslag",
    original_url: "https://api.notubiz.nl/document/13165092/1",
    file_name: "verslag.txt",
    content_type: "text/plain",
    date_modified: "2026-04-03T08:00:00Z",
    source_info: {
      supplier: "notubiz",
      source: "baarn",
      organization_type: "gemeente",
      canonical_id: "13165092",
      canonical_iri: "https://api.notubiz.nl/document/13165092/1",
    },
    raw: {
      id: 13165092,
      version: 1,
      last_modified: "2026-04-03 08:00:00",
    },
  };
}

Deno.test("assessMarkdownQuality keeps normal prose in the good range", () => {
  const result = assessMarkdownQuality(
    "Gemeente Baarn. Verslag van de openbare bijeenkomst gehouden op woensdag 10 april 2026.",
  );

  assert(result.status === "good", "expected normal prose to score as good");
  assert(result.score >= 0.8, `expected a high quality score, got ${result.score}`);
});

Deno.test("assessMarkdownQuality flags garbled text as suspect", () => {
  const result = assessMarkdownQuality(
    "\u0007\u0017 \u0007\u0007\b\u0007\u0004 \u0010\u0007\u0013\u0015\u0005\u0016\u0014\u0017\u0016\u0004\u0017\b\u0002\u0002 !\"\u0017\u0011\u0003\u0014\u0011#\u0007\b\u0017!$!",
  );

  assert(result.status === "suspect", "expected gibberish to be flagged as suspect");
  assert(result.score < 0.5, `expected a low score, got ${result.score}`);
});

Deno.test("assessMarkdownQuality flags interleaved control-character garbage as suspect", () => {
  const result = assessMarkdownQuality(
    "\u0003\uFFFD\u0003\u000B\u0003\u000B\u0003\u000B\u0003\u000B\u0003\u000B\u0003\u000B\u0011\u0001\u001E\u0001\uFFFD\u0001\uFFFD\u0001\uFFFD\u0001\uFFFD /\\u0001v\\u0001Z\\u0001}\\u0001FF\\u0001n\\u0001P  \u0003 /\\u0001v\\u0001o\\u0001\u001E\\u0001]\\u0001]\\u0001v\\u0001P \u0003\u0003X\u0003X\u0003X Inleiding \u0003\u0003X\u0003X\u0003X",
  );

  assert(result.status === "suspect", "expected interleaved-control garbage to be suspect");
  assert(result.score < 0.35, `expected a very low score, got ${result.score}`);
});

Deno.test("assessMarkdownQuality treats empty markdown as suspect", () => {
  const result = assessMarkdownQuality("");

  assert(result.status === "suspect", "expected empty markdown to be suspect");
  assert(result.score === 0, `expected empty markdown to score 0, got ${result.score}`);
});

Deno.test("materializeDocument stores suspect quality metadata without emitting an issue", async () => {
  const storage = new FakeStorage();
  const fileKey =
    "documents/notubiz/gemeente/baarn/13165092/1-2026-04-03T08_00_00/verslag.txt";
  const markdownKey = `${fileKey}.pymupdf-v1.md`;
  await storage.putObject(fileKey, new TextEncoder().encode("cached file"));
  await storage.putObject(
    markdownKey,
    new TextEncoder().encode(
      "\u0007\u0017 \u0007\u0007\b\u0007\u0004 \u0010\u0007\u0013\u0015\u0005\u0016\u0014\u0017\u0016\u0004\u0017\b\u0002\u0002 !\"",
    ),
  );
  const result = await materializeDocument(buildDocument(), {
    storage,
    download: async () => new TextEncoder().encode("unused"),
  });

  assert(result.issues.length === 0, "expected suspect quality to stay out of run issues");
  assert(
    result.document.derived_content?.extraction_quality_status === "suspect",
    "expected derived content to expose suspect quality status",
  );
});
