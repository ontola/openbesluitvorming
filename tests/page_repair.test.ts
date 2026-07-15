// The page-chunks repair path: a cached PDF whose markdown exists but whose
// page-chunks object is missing must be re-extracted through the extraction
// service — from our own cached copy, never from the supplier — and fall
// back to the plain cache hit when the service fails.
Deno.env.set("WOOZI_EXTRACTION_SERVICE_URL", "http://extractie.test:8000");
Deno.env.set("WOOZI_KV_PATH", await Deno.makeTempFile({ suffix: ".sqlite3" }));

import { materializeDocument } from "../src/documents/process.ts";
import type { DocumentEntity } from "../src/types.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

class FakeStorage {
  readonly objects = new Map<string, Uint8Array>();

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

function buildPdfDocument(): DocumentEntity {
  return {
    id: "document:notubiz:gemeente:baarn:13165092",
    type: "Document",
    name: "Raadsvoorstel",
    original_url: "https://api.notubiz.nl/document/13165092/1",
    file_name: "raadsvoorstel.pdf",
    content_type: "application/pdf",
    date_modified: "2026-04-03T08:00:00Z",
    source_info: {
      supplier: "notubiz",
      source: "baarn",
      organization_type: "gemeente",
      canonical_id: "13165092",
      canonical_iri: "https://api.notubiz.nl/document/13165092/1",
    },
    raw: { id: 13165092, version: 1 },
  };
}

async function seedCacheWithoutChunks(storage: FakeStorage, document: DocumentEntity) {
  // Mirror the object keys the pipeline uses: probe them via a service
  // failure run, which touches file+markdown keys through readCachedDocument.
  // Simpler: derive the keys the same way the code does — via a first
  // materialize call that hits the service; instead we just seed by asking
  // the storage what exists after a canonical put. The keys are stable and
  // documented: documents/{supplier}/{orgtype}/{source}/{id}/{version-date}/…
  // To stay robust against key-format changes, we let a fake service run
  // fill the cache once, then delete only the page-chunks object.
  const chunksKeys: string[] = [];
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.text() : "{}")));
    for (const key of [body.s3_pdf_key, body.s3_markdown_key]) {
      if (key) await storage.putObject(key, new TextEncoder().encode("cached"));
    }
    if (body.s3_page_chunks_key) chunksKeys.push(body.s3_page_chunks_key);
    return Response.json({
      markdown: "# Inhoud",
      page_chunks: [],
      page_count: 3,
      warnings: [],
      s3_pdf_url: storage.urlForKey(body.s3_pdf_key),
    });
  }) as typeof fetch;
  await materializeDocument(document, {
    storage,
    download: async () => new TextEncoder().encode("unused"),
  });
  return { chunksKey: chunksKeys[0] ?? "" };
}

Deno.test("cache hit without page chunks re-extracts from the cached PDF", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const storage = new FakeStorage();
    const document = buildPdfDocument();
    const { chunksKey } = await seedCacheWithoutChunks(storage, document);
    assert(chunksKey, "service request should carry a page-chunks key");
    assert(!storage.objects.has(chunksKey), "seed run left no chunks object");

    let requestedSourceUrl = "";
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      requestedSourceUrl = body.source_url;
      return Response.json({
        markdown: "# Inhoud\n\nPagina twee tekst",
        page_chunks: [
          { page_number: 1, markdown: "# Inhoud" },
          { page_number: 2, markdown: "Pagina twee tekst" },
        ],
        page_count: 2,
        warnings: [],
        s3_pdf_url: storage.urlForKey(body.s3_pdf_key),
      });
    }) as typeof fetch;

    const result = await materializeDocument(document, {
      storage,
      download: async () => new TextEncoder().encode("unused"),
    });

    assert(
      requestedSourceUrl.startsWith("http://storage.test/"),
      `repair must download from our cache, not the supplier (got ${requestedSourceUrl})`,
    );
    assert(result.document.page_chunks?.length === 2, "repair yields page chunks");
    assert(
      result.document.derived_content?.page_chunks_key === chunksKey,
      "derived content points at the chunks object",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("failed page repair keeps the plain cache hit with a warning", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const storage = new FakeStorage();
    const document = buildPdfDocument();
    await seedCacheWithoutChunks(storage, document);

    globalThis.fetch = (async () =>
      new Response("boom", { status: 500 })) as typeof fetch;

    const result = await materializeDocument(document, {
      storage,
      download: async () => new TextEncoder().encode("unused"),
    });

    assert(result.cacheHit, "fallback is the plain cache hit");
    assert(
      result.document.derived_content?.markdown_key,
      "cached markdown stays referenced",
    );
    assert(
      result.issues.some(
        (issue) => issue.severity === "warning" && issue.message.includes("page-chunks repair"),
      ),
      "repair failure surfaces as a warning issue",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("cache hit with page chunks present stays a cheap cache hit", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const storage = new FakeStorage();
    const document = buildPdfDocument();
    const { chunksKey } = await seedCacheWithoutChunks(storage, document);
    await storage.putObject(
      chunksKey,
      new TextEncoder().encode(JSON.stringify({ pages: [] })),
    );

    globalThis.fetch = (async () => {
      throw new Error("service must not be called on a complete cache hit");
    }) as typeof fetch;

    const result = await materializeDocument(document, {
      storage,
      download: async () => new TextEncoder().encode("unused"),
    });

    assert(result.cacheHit, "complete cache stays a cache hit");
    assert(
      result.document.derived_content?.page_chunks_key === chunksKey,
      "cache hit keeps the chunks key",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
