import { IngestStallError, raceStallWatchdog } from "../src/ingest_watchdog.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

Deno.test("raceStallWatchdog passes a fast result straight through", async () => {
  const result = await raceStallWatchdog({
    stallTimeoutMs: 200,
    checkIntervalMs: 20,
    work: async () => {
      await delay(10);
      return "done";
    },
  });
  assert(result === "done", `expected work result to pass through, got ${result}`);
});

Deno.test("raceStallWatchdog propagates a work rejection unchanged", async () => {
  let error: unknown;
  try {
    await raceStallWatchdog({
      stallTimeoutMs: 200,
      checkIntervalMs: 20,
      work: () => Promise.reject(new Error("boom")),
    });
  } catch (caught) {
    error = caught;
  }
  assert(
    error instanceof Error && error.message === "boom",
    `expected the work error, got ${error}`,
  );
  assert(!(error instanceof IngestStallError), "a real failure must not be reported as a stall");
});

Deno.test("raceStallWatchdog does not reap work that keeps emitting heartbeats", async () => {
  // Runs ~300ms — well past the 150ms stall timeout — but beats steadily.
  const result = await raceStallWatchdog({
    stallTimeoutMs: 150,
    checkIntervalMs: 20,
    work: async (heartbeat) => {
      for (let i = 0; i < 6; i += 1) {
        heartbeat();
        await delay(50);
      }
      return "ok";
    },
  });
  assert(result === "ok", "steady heartbeats should prevent a stall");
});

Deno.test("raceStallWatchdog reaps work that goes silent after starting", async () => {
  let error: unknown;
  try {
    await raceStallWatchdog({
      stallTimeoutMs: 100,
      checkIntervalMs: 20,
      work: (heartbeat) => {
        heartbeat(); // one beat, then silence forever
        return new Promise<string>(() => {});
      },
    });
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof IngestStallError, `expected IngestStallError, got ${error}`);
});

Deno.test("raceStallWatchdog reaps work that never beats at all", async () => {
  let error: unknown;
  try {
    await raceStallWatchdog({
      stallTimeoutMs: 100,
      checkIntervalMs: 20,
      work: () => new Promise<string>(() => {}),
    });
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof IngestStallError, `expected IngestStallError, got ${error}`);
});
