import { QuickwitClient } from "../src/quickwit/client.ts";
import type { QuickwitSearchDocument } from "../src/quickwit/project.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function row(entityId: string, contentBytes: number): QuickwitSearchDocument {
  return {
    entity_id: entityId,
    entity_type: "DocumentPage",
    content: "x".repeat(contentBytes),
  } as unknown as QuickwitSearchDocument;
}

/** A row the index refuses on its own must cost that row, not its source.
 *
 * Leidschendam-Voorburg holds two rows of 11.1 MB in 234,354 -- single PDF
 * pages whose extracted text exceeds Quickwit's 10 MiB limit. The whole
 * municipality stayed out of the new index because of them: halving a batch
 * bottoms out at one line, and that line then threw and ended the run.
 *
 * The commit that introduced halving claimed a single unsplittable row was
 * "reported rather than silently dropped". It was not -- it was thrown. This
 * test is what that claim should have been resting on.
 */
Deno.test("one row too large for the index does not take its source with it", async () => {
  const originalFetch = globalThis.fetch;
  const accepted: string[][] = [];

  globalThis.fetch = async (_input, init) => {
    const body = String((init as { body?: string } | undefined)?.body ?? "");
    const lines = body.split("\n");
    // Stand in for Quickwit: refuse anything holding the oversized row.
    if (lines.some((line) => line.includes("te-groot"))) {
      return new Response('{"message": "The request payload is too large"}', { status: 413 });
    }
    accepted.push(lines);
    return new Response('{"num_docs_for_processing": 1}', { status: 200 });
  };

  try {
    const skipped: Array<{ entityId?: string; bytes: number }> = [];
    const client = new QuickwitClient();

    await client.ingestDocuments(
      [row("document:goed:1", 100), row("document:te-groot", 200), row("document:goed:2", 100)],
      (info) => skipped.push(info),
    );

    assert(skipped.length === 1, `exactly one row should be skipped, got ${skipped.length}`);
    assert(
      skipped[0].entityId === "document:te-groot",
      `the skipped row should be named, got ${skipped[0].entityId}`,
    );
    assert(skipped[0].bytes > 0, "the skipped row's size should be reported");

    const landed = accepted.flat().join("\n");
    assert(landed.includes("document:goed:1"), "the rows around it must still land");
    assert(landed.includes("document:goed:2"), "the rows around it must still land");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("a batch with no oversized row reports nothing skipped", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"num_docs_for_processing": 2}', { status: 200 });

  try {
    const skipped: unknown[] = [];
    await new QuickwitClient().ingestDocuments(
      [row("document:goed:1", 100), row("document:goed:2", 100)],
      (info) => skipped.push(info),
    );
    assert(skipped.length === 0, "an ordinary batch skips nothing");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
