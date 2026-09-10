import { assert, assertRejects } from "jsr:@std/assert";

// The timeout is read once at module load, so set it before importing.
Deno.env.set("WOOZI_S3_READ_TIMEOUT_MS", "80");
Deno.env.set("S3_STORAGE_BUCKET_NAME", "test-bucket");
Deno.env.set("S3_STORAGE_ENDPOINT", "https://storage.test");
Deno.env.set("S3_STORAGE_REGION", "test-1");
Deno.env.set("S3_ACCESS_KEY", "key");
Deno.env.set("S3_SECRET_KEY", "secret");
const { ObjectStorageClient } = await import("../src/storage/s3.ts");

type FetchFn = typeof globalThis.fetch;

async function withFetch<T>(stub: FetchFn, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function keyOf(input: RequestInfo | URL): string {
  const url = new URL(input instanceof Request ? input.url : String(input));
  return decodeURIComponent(url.pathname.split("/").slice(2).join("/"));
}

Deno.test("one object that keeps failing does not stop the others from being deleted", async () => {
  // 2026-09-10: purging Goeree-Overflakkee listed tens of thousands of keys
  // and the store failed a handful of deletes per pass; aborting at the first
  // one restarted the pass from the beginning, forever.
  const deleted: string[] = [];
  const stub: FetchFn = async (input, init) => {
    const method = input instanceof Request ? input.method : init?.method;
    if (method !== "DELETE") {
      throw new Error(`only DELETE expected, got ${method}`);
    }
    const key = keyOf(input);
    if (key === "documents/bad") {
      return new Response("", { status: 503 });
    }
    deleted.push(key);
    return new Response(null, { status: 204 });
  };
  const client = await ObjectStorageClient.fromEnvironment();
  await withFetch(stub, async () => {
    const error = await assertRejects(
      () => client.deleteObjects(["documents/a", "documents/bad", "documents/b"]),
      Error,
    );
    assert(
      error.message.includes("1 of 3"),
      `the failure is reported at the end, got ${error.message}`,
    );
  });
  assert(
    deleted.includes("documents/a") && deleted.includes("documents/b"),
    "the other two were deleted",
  );
});

Deno.test("a delete that fails once is retried, and a 404 counts as done", async () => {
  let attempts = 0;
  const stub: FetchFn = async (input) => {
    const key = keyOf(input);
    if (key === "documents/flaky") {
      attempts += 1;
      return new Response(attempts === 1 ? "" : null, { status: attempts === 1 ? 500 : 204 });
    }
    return new Response("", { status: 404 });
  };
  const client = await ObjectStorageClient.fromEnvironment();
  await withFetch(stub, () => client.deleteObjects(["documents/flaky", "documents/gone"]));
  assert(attempts === 2, `retried once, got ${attempts} attempts`);
});
