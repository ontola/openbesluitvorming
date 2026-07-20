// Health-aware extraction routing: a node whose own /health check fails
// (observed in production: an overloaded 2 vCPU node not answering its own
// health endpoint within 10s) must be skipped in favor of a healthy node,
// rather than round-robin blindly sending it a request that would otherwise
// eat the full 3-minute extraction timeout.
Deno.env.set(
  "WOOZI_EXTRACTION_SERVICE_URL",
  "http://bad-node.test:8000,http://good-node.test:8000",
);
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

function buildPdfDocument(id: string): DocumentEntity {
  return {
    id: `document:notubiz:gemeente:baarn:${id}`,
    type: "Document",
    name: "Raadsvoorstel",
    original_url: `https://api.notubiz.nl/document/${id}/1`,
    file_name: "raadsvoorstel.pdf",
    content_type: "application/pdf",
    date_modified: "2026-04-03T08:00:00Z",
    source_info: {
      supplier: "notubiz",
      source: "baarn",
      organization_type: "gemeente",
      canonical_id: id,
      canonical_iri: `https://api.notubiz.nl/document/${id}/1`,
    },
    raw: { id: Number(id), version: 1 },
  };
}

Deno.test("routing skips a node whose /health check fails", async () => {
  const originalFetch = globalThis.fetch;
  const extractHits: string[] = [];
  try {
    globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/health")) {
        if (url.startsWith("http://bad-node.test")) {
          return new Response("nope", { status: 500 });
        }
        return new Response("ok", { status: 200 });
      }
      if (url.includes("/extract")) {
        extractHits.push(url);
        return Response.json({
          markdown: "# Inhoud",
          page_chunks: [],
          page_count: 1,
          warnings: [],
          s3_pdf_url: "http://storage.test/woozi/x",
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const storage = new FakeStorage();
    const download = async () => new TextEncoder().encode("unused");

    // Round trip 1: cold cache, bad-node picked (fail-open), background
    // health probe fires for it.
    await materializeDocument(buildPdfDocument("1"), { storage, download });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Round trip 2: natural rotation lands on good-node anyway; also warms
    // its (healthy) cache entry.
    await materializeDocument(buildPdfDocument("2"), { storage, download });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Round trip 3: natural rotation would return to bad-node, but it's
    // cached unhealthy — must be skipped in favor of good-node.
    await materializeDocument(buildPdfDocument("3"), { storage, download });

    assert(extractHits.length === 3, `expected 3 extract calls, got ${extractHits.length}`);
    assert(
      extractHits[2].startsWith("http://good-node.test"),
      `round 3 should skip the unhealthy node, got ${extractHits[2]}`,
    );
    assert(
      !extractHits.slice(1).some((url) => url.startsWith("http://bad-node.test")),
      "bad-node should not be reused once marked unhealthy",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
