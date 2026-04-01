import { computeAllowedIngestConcurrency } from "../src/ingest_scheduler.ts";

function assertEquals(actual: unknown, expected: unknown, message?: string): void {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${expected}, got ${actual}`);
  }
}

Deno.test("computeAllowedIngestConcurrency caps by configured concurrency", () => {
  const allowed = computeAllowedIngestConcurrency({
    configuredConcurrency: 4,
    availableMemoryBytes: 24 * 1024 * 1024 * 1024,
    memoryPerJobMb: 1400,
    minFreeMemoryMb: 1024,
  });

  assertEquals(allowed, 4);
});

Deno.test("computeAllowedIngestConcurrency reduces concurrency when memory is tight", () => {
  const allowed = computeAllowedIngestConcurrency({
    configuredConcurrency: 4,
    availableMemoryBytes: 3 * 1024 * 1024 * 1024,
    memoryPerJobMb: 1400,
    minFreeMemoryMb: 1024,
  });

  assertEquals(allowed, 1);
});

Deno.test("computeAllowedIngestConcurrency never drops below one", () => {
  const allowed = computeAllowedIngestConcurrency({
    configuredConcurrency: 4,
    availableMemoryBytes: 256 * 1024 * 1024,
    memoryPerJobMb: 1400,
    minFreeMemoryMb: 1024,
  });

  assertEquals(allowed, 1);
});
