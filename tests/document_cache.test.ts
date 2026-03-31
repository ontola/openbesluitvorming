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
}

function buildDocument(): DocumentEntity {
  return {
    id: "document:notubiz:gemeente:haarlem:42",
    type: "Document",
    name: "Memo participatie",
    original_url: "https://api.notubiz.nl/document/42/1",
    file_name: "memo.txt",
    content_type: "text/plain",
    date_modified: "2025-01-16T11:03:37Z",
    source_info: {
      supplier: "notubiz",
      source: "haarlem",
      organization_type: "gemeente",
      canonical_id: "42",
      canonical_iri: "https://api.notubiz.nl/document/42/1",
    },
    raw: {
      id: 42,
      version: 1,
      last_modified: "2025-01-16 11:03:37",
    },
  };
}

Deno.test("materializeDocument reuses cached file and extracted markdown from storage", async () => {
  const storage = new FakeStorage();
  const document = buildDocument();
  let downloads = 0;

  const first = await materializeDocument(document, {
    storage,
    download: async () => {
      downloads += 1;
      return new TextEncoder().encode("Dit is de opgeslagen platte tekst.");
    },
  });

  const second = await materializeDocument(document, {
    storage,
    download: async () => {
      downloads += 1;
      return new TextEncoder().encode("Dit zou niet opnieuw opgehaald moeten worden.");
    },
  });

  assert(downloads === 1, "expected second materialization to reuse cache");
  assert(
    first.document.media_urls?.[0]?.url === second.document.media_urls?.[0]?.url,
    "expected cached media url to be reused",
  );
  assert(
    first.document.media_urls?.[0]?.url ===
      "http://storage.test/woozi/documents/notubiz/gemeente/haarlem/42/1-2025-01-16T11_03_37/memo.txt",
    "expected storage key to stay aligned with the scoped identifier tuple",
  );
  assert(
    second.document.md_text?.[0] === "Dit is de opgeslagen platte tekst.",
    "expected cached extracted markdown",
  );
});
