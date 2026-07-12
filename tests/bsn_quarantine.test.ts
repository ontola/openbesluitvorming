// Uses a temp ops database so blocklist writes stay out of the dev sqlite,
// and pins the extraction service off so a local .env cannot reroute
// materializeDocument through a remote extraction worker.
Deno.env.set("WOOZI_KV_PATH", await Deno.makeTempFile({ suffix: ".sqlite3" }));
// A single space: loadLocalEnv only fills unset/empty vars, and the URL is trimmed before use.
Deno.env.set("WOOZI_EXTRACTION_SERVICE_URL", " ");

import { materializeDocument } from "../src/documents/process.ts";
import {
  addDocumentToBlocklist,
  isDocumentBlocklisted,
  removeDocumentFromBlocklist,
} from "../src/ops/store.ts";
import type { DocumentEntity } from "../src/types.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

class FakeStorage {
  readonly objects = new Map<string, Uint8Array>();
  readonly deletedKeys: string[] = [];

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

  async deleteObjects(keys: string[]): Promise<void> {
    for (const key of keys) {
      this.objects.delete(key);
      this.deletedKeys.push(key);
    }
  }
}

function buildDocument(id: string): DocumentEntity {
  return {
    id: `document:notubiz:gemeente:baarn:${id}`,
    type: "Document",
    name: "Verslag",
    original_url: `https://api.notubiz.nl/document/${id}/1`,
    file_name: "verslag.log",
    content_type: "text/plain",
    date_modified: "2026-04-03T08:00:00Z",
    source_info: {
      supplier: "notubiz",
      source: "baarn",
      organization_type: "gemeente",
      canonical_id: id,
      canonical_iri: `https://api.notubiz.nl/document/${id}/1`,
    },
    raw: {
      id: Number(id),
      version: 1,
      last_modified: "2026-04-03 08:00:00",
    },
  };
}

Deno.test("materializeDocument only reports a BSN hit by default (detect-only)", async () => {
  const document = buildDocument("90000003");
  const storage = new FakeStorage();
  const result = await materializeDocument(document, {
    storage,
    download: async () =>
      new TextEncoder().encode(
        "Bijlage bij de aanvraag. Naam: J. Jansen, BSN: 123456782, geboren te Utrecht.",
      ),
  });

  assert(!result.blocked, "expected no blocking without WOOZI_BSN_AUTO_QUARANTINE=1");
  assert(storage.objects.size > 0, "expected normal S3 writes to continue");
  assert(
    result.issues.some(
      (issue) =>
        issue.step === "bsn_quarantine" &&
        issue.severity === "warning" &&
        issue.message.includes("high"),
    ),
    "expected a high-confidence review warning",
  );
  assert(!(await isDocumentBlocklisted(document.id)), "expected no automatic blocklist entry");
});

Deno.test("materializeDocument quarantines a BSN document when auto-quarantine is enabled", async () => {
  const document = buildDocument("90000001");
  Deno.env.set("WOOZI_BSN_AUTO_QUARANTINE", "1");
  try {
    const storage = new FakeStorage();
    const result = await materializeDocument(document, {
      storage,
      download: async () =>
        new TextEncoder().encode(
          "Bijlage bij de aanvraag. Naam: J. Jansen, BSN: 123456782, geboren te Utrecht.",
        ),
    });

    assert(result.blocked === true, "expected the document to be blocked");
    assert(storage.objects.size === 0, "expected no S3 writes for a quarantined document");
    assert(
      result.issues.some((issue) => issue.step === "bsn_quarantine" && issue.severity === "error"),
      "expected a bsn_quarantine error issue",
    );
    const details = result.issues.find((issue) => issue.step === "bsn_quarantine")?.details ?? "";
    assert(!details.includes("123456782"), "issue details must not contain the raw BSN");
    assert(
      result.document.md_text === undefined && result.document.derived_content === undefined,
      "expected no extracted content on the returned entity",
    );
    assert(await isDocumentBlocklisted(document.id), "expected the document to be blocklisted");

    // A later import run must skip the document before downloading anything.
    let downloadCalled = false;
    const secondRun = await materializeDocument(document, {
      storage,
      download: async () => {
        downloadCalled = true;
        return new TextEncoder().encode("unused");
      },
    });
    assert(secondRun.blocked === true, "expected the blocklisted document to stay blocked");
    assert(!downloadCalled, "expected no download for a blocklisted document");
  } finally {
    Deno.env.delete("WOOZI_BSN_AUTO_QUARANTINE");
    await removeDocumentFromBlocklist(document.id);
  }
});

Deno.test("materializeDocument keeps skipping explicitly blocklisted documents", async () => {
  const document = buildDocument("90000004");
  await addDocumentToBlocklist(document.id, "takedown", "manual");
  try {
    let downloadCalled = false;
    const result = await materializeDocument(document, {
      storage: new FakeStorage(),
      download: async () => {
        downloadCalled = true;
        return new TextEncoder().encode("unused");
      },
    });
    assert(result.blocked === true, "expected the blocklisted document to be blocked");
    assert(!downloadCalled, "expected no download for a blocklisted document");
  } finally {
    await removeDocumentFromBlocklist(document.id);
  }
});

Deno.test("materializeDocument keeps a medium-confidence hit with a review warning", async () => {
  const document = buildDocument("90000002");
  const storage = new FakeStorage();
  const result = await materializeDocument(document, {
    storage,
    download: async () =>
      new TextEncoder().encode(
        "Verslag van de vergadering. Het dossier met nummer 111222333 is besproken en gesloten.",
      ),
  });

  assert(!result.blocked, "expected a medium-confidence hit not to block");
  assert(
    result.issues.some((issue) => issue.step === "bsn_quarantine" && issue.severity === "warning"),
    "expected a review warning issue",
  );
  assert(storage.objects.size > 0, "expected normal S3 writes to continue");
  assert(!(await isDocumentBlocklisted(document.id)), "expected no blocklist entry");
});

Deno.test("blocklist add/remove roundtrip", async () => {
  const entityId = "document:test:gemeente:test:roundtrip";
  await addDocumentToBlocklist(entityId, "takedown", "test");
  assert(await isDocumentBlocklisted(entityId), "expected entity to be blocklisted");
  await removeDocumentFromBlocklist(entityId);
  assert(!(await isDocumentBlocklisted(entityId)), "expected entity to be removed");
});
