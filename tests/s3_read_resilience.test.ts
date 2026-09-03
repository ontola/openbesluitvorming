import { assertEquals, assertRejects } from "jsr:@std/assert";

// The read timeout is read once at module load, so set it before importing.
Deno.env.set("WOOZI_S3_READ_TIMEOUT_MS", "80");
Deno.env.set("S3_STORAGE_BUCKET_NAME", "test-bucket");
Deno.env.set("S3_STORAGE_ENDPOINT", "https://storage.test");
Deno.env.set("S3_STORAGE_REGION", "test-1");
Deno.env.set("S3_ACCESS_KEY", "key");
Deno.env.set("S3_SECRET_KEY", "secret");
const { ObjectStorageClient } = await import("../src/storage/s3.ts");

type FetchFn = typeof globalThis.fetch;

async function withFetch<T>(stub: FetchFn, body: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("a read that hangs is abandoned at the timeout and retried", async () => {
  // Measured 2026-09-03: a few reads per hundred took 6-60s, and the same
  // key would then answer promptly on the next attempt.
  let calls = 0;
  const stub: FetchFn = (_input, init) => {
    calls += 1;
    if (calls < 3) {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    }
    return Promise.resolve(new Response("inhoud", { status: 200 }));
  };
  const storage = await ObjectStorageClient.fromEnvironment();
  const text = await withFetch(stub, () => storage.getObjectText("text/doc.md"));
  assertEquals(text, "inhoud");
  assertEquals(calls, 3);
});

Deno.test("a gateway timeout is retried, and given up after three attempts", async () => {
  let calls = 0;
  const stub: FetchFn = () => {
    calls += 1;
    return Promise.resolve(new Response("upstream timed out", { status: 504 }));
  };
  const storage = await ObjectStorageClient.fromEnvironment();
  await assertRejects(
    () => withFetch(stub, () => storage.getObjectBytes("text/doc.md")),
    Error,
    "504",
  );
  assertEquals(calls, 3);
});

Deno.test("absent is an answer: 404 is returned at once, not retried", async () => {
  let calls = 0;
  const stub: FetchFn = () => {
    calls += 1;
    return Promise.resolve(new Response("", { status: 404 }));
  };
  const storage = await ObjectStorageClient.fromEnvironment();
  const bytes = await withFetch(stub, () => storage.getObjectBytes("text/missing.md"));
  assertEquals(bytes, null);
  assertEquals(calls, 1);
});
