import { buildSegments, parseTranscriptCues } from "../src/recordings/transcript.ts";
import { notubizStreamUrl } from "../src/notubiz/recordings.ts";
import type { NotubizMedia } from "../src/types.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

// Notubiz: SRT, comma decimals, CRLF, cue numbers, and a line wrapped
// mid-sentence with a trailing ellipsis.
const SRT = [
  "1",
  "00:00:10,140 --> 00:00:11,080",
  "Dames en heren,",
  "",
  "2",
  "00:00:13,939 --> 00:00:18,120",
  "ik open deze bijzondere",
  "vergadering van de gemeenteraad van...",
  "",
  "3",
  "00:01:18,219 --> 00:01:21,059",
  "Amsterdam.",
].join("\r\n");

// Company Webcast: WebVTT, dot decimals, no cue numbers, optional hour.
const VTT = [
  "WEBVTT",
  "",
  "0:05:50.201 --> 0:06:04.641",
  "Dames en heren, een bijzonder goedenavond.",
  "",
  "06:04.641 --> 06:08.611",
  "Welkom collegeleden, pers.",
].join("\n");

Deno.test("SRT and WebVTT parse through the same path", () => {
  const srt = parseTranscriptCues(SRT);
  assertEquals(srt.length, 3, "srt cue count");
  assertEquals(srt[0].start_seconds, 10.14, "srt start seconds");
  assertEquals(
    srt[1].text,
    "ik open deze bijzondere vergadering van de gemeenteraad van",
    "wrapped lines join and the continuation ellipsis is dropped",
  );
  assertEquals(srt[2].start_seconds, 78.219, "minutes carry into seconds");

  const vtt = parseTranscriptCues(VTT);
  assertEquals(vtt.length, 2, "vtt cue count, header ignored");
  assertEquals(vtt[0].start_seconds, 350.201, "vtt start seconds");
  assertEquals(vtt[1].start_seconds, 364.641, "an omitted hour is mm:ss");
});

Deno.test("cues merge into readable blocks, split on a long silence", () => {
  const cues = parseTranscriptCues(SRT);
  const segments = buildSegments(cues, { targetSeconds: 120, maxGapSeconds: 8 });

  assertEquals(segments.length, 2, "the 57s silence before cue 3 starts a new block");
  assertEquals(segments[0].start_seconds, 10.14, "block starts at the first cue");
  assertEquals(segments[0].end_seconds, 18.12, "block ends at the last cue it absorbed");
  assert(segments[0].text.startsWith("Dames en heren,"), "text is concatenated in order");
  assert(segments[0].text.includes("gemeenteraad van"), "both cues land in one block");
  assertEquals(segments[1].text, "Amsterdam.", "the post-silence cue is its own block");
});

Deno.test("a block never runs across a speaker change", () => {
  const cues = parseTranscriptCues(SRT);
  const segments = buildSegments(cues, {
    targetSeconds: 600,
    maxGapSeconds: 600,
    speakers: [
      { start_seconds: 0, end_seconds: 12, name: "Voorzitter" },
      { start_seconds: 12, end_seconds: 20, name: "Raadslid" },
    ],
  });

  assertEquals(segments.length, 3, "one block per speaker stretch, not one long block");
  assertEquals(segments[0].speaker, "Voorzitter", "first block attributed to the chair");
  assertEquals(segments[1].speaker, "Raadslid", "second block attributed to the member");
  assertEquals(segments[2].speaker, undefined, "past the last speaker stretch, nobody is claimed");
});

Deno.test("the seekable HLS url is derived from the wowza coordinates", () => {
  const media = {
    id: 392881,
    event_id: 1412355,
    media_type: "video",
    streamer: "rtmp://wowza1.notubiz.nl/nbvod/_definst_",
    stream_name: "Nunspeet/bestanden/01.04.26 Nunspeet  Raad.mp4",
  } satisfies NotubizMedia;

  assertEquals(
    notubizStreamUrl(media),
    "https://wowza1.notubiz.nl/nbvod/_definst_/mp4:Nunspeet/bestanden/01.04.26%20Nunspeet%20%20Raad.mp4/playlist.m3u8",
    "path segments are escaped, the mp4: selector is not",
  );

  assertEquals(
    notubizStreamUrl({ ...media, streamer: undefined }),
    undefined,
    "no streamer means no stream url, rather than a guessed one",
  );
});

Deno.test("a connection that cannot be established is retried, not fatal", async () => {
  // 22 of 128 sources failed the first media backfill on this alone: Deno
  // reports an unestablished connection as "error sending request", which the
  // Notubiz client did not recognise as retryable even though the iBabs client
  // already had. One dropped connection failed a whole source.
  const { __test__ } = await import("../src/notubiz/client.ts");
  const retryable = __test__.isRetryableError;

  assert(
    retryable(new TypeError("error sending request for url (https://api.notubiz.nl/events)")),
    "an unestablished connection must be retried",
  );
  assert(retryable(new Error("connection reset by peer")), "existing cases still retry");
  assert(
    !retryable(new Error("Request failed 404 for https://api.notubiz.nl/x")),
    "a real 404 must not be retried forever",
  );
});
