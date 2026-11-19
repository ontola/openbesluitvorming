import { assert, assertEquals, assertRejects } from "jsr:@std/assert";

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

Deno.test("a throttled read backs off and is given up after six attempts", async () => {
  // Object storage says `503 SlowDown` to a burst; the answer is to wait,
  // and to obey Retry-After when it is given. The stub advises a tiny wait so
  // the test stays fast while proving the header is honoured.
  let calls = 0;
  const started = performance.now();
  const stub: FetchFn = () => {
    calls += 1;
    return Promise.resolve(
      new Response("SlowDown: Please reduce your request rate", {
        status: 503,
        headers: { "retry-after": "0.01" },
      }),
    );
  };
  const storage = await ObjectStorageClient.fromEnvironment();
  await assertRejects(
    () => withFetch(stub, () => storage.getObjectBytes("text/doc.md")),
    Error,
    "503",
  );
  assertEquals(calls, 6);
  assert(
    performance.now() - started < 2000,
    "Retry-After of 10ms must not be ignored for a 1s back-off",
  );
});

Deno.test("a throttled read that recovers returns the object", async () => {
  let calls = 0;
  const stub: FetchFn = () => {
    calls += 1;
    if (calls < 3) {
      return Promise.resolve(
        new Response("SlowDown", { status: 503, headers: { "retry-after": "0.01" } }),
      );
    }
    return Promise.resolve(new Response("inhoud", { status: 200 }));
  };
  const storage = await ObjectStorageClient.fromEnvironment();
  const text = await withFetch(stub, () => storage.getObjectText("text/doc.md"));
  assertEquals(text, "inhoud");
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

Deno.test("streamObjectLines hands out the first lines of a slow object and stops there (#429)", async () => {
  // A legacy changes segment took longer to download than one read may take.
  // Streamed, the first line arrives at once; the caller stops, and the rest
  // is never fetched. The body here trickles one line per 30ms, under the
  // 80ms silence ceiling, for far longer than that ceiling in total.
  let cancelled = false;
  let sent = 0;
  const stub: FetchFn = () => {
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        sent += 1;
        controller.enqueue(new TextEncoder().encode(`{"seq":${sent - 1}}\n`));
      },
      cancel() {
        cancelled = true;
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  };
  const storage = await ObjectStorageClient.fromEnvironment();
  const lines = await withFetch(stub, async () => {
    const out: string[] = [];
    for await (const line of storage.streamObjectLines("exports/x/changes/0-9.ndjson")) {
      out.push(line);
      if (out.length === 5) {
        break;
      }
    }
    return out;
  });
  assertEquals(lines, ['{"seq":0}', '{"seq":1}', '{"seq":2}', '{"seq":3}', '{"seq":4}']);
  assert(cancelled, "the rest of the object is not downloaded");
});

Deno.test("streamObjectLines gives up on a body that goes silent (#429)", async () => {
  const stub: FetchFn = (_input, init) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"seq":0}\n'));
        init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  };
  const storage = await ObjectStorageClient.fromEnvironment();
  await withFetch(stub, () =>
    assertRejects(
      async () => {
        for await (const _line of storage.streamObjectLines("exports/x/changes/0-9.ndjson")) {
          // keep reading
        }
      },
      Error,
      "S3 read failed",
    ),
  );
});
