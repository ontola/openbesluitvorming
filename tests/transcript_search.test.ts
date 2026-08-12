import {
  findMatches,
  searchableSegments,
  segmentOfMatch,
  splitOnMatches,
} from "../web/src/transcript_search.ts";
import type { RecordingSegment } from "../src/types.ts";

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

function segment(start: number, text: string): RecordingSegment {
  return { start_seconds: start, end_seconds: start + 60, text };
}

const TRANSCRIPT: RecordingSegment[] = [
  segment(0, "Wij openen de vergadering over het Testterrein."),
  segment(60, "Geen opmerkingen bij dit punt."),
  segment(120, "Een test, en nog een test in dezelfde alinea."),
];

Deno.test("a term is found in every segment that speaks it, with running offsets", () => {
  const found = findMatches(searchableSegments(TRANSCRIPT), "test");

  assertEquals(found.total, 3, "one hit in the first segment and two in the last");
  assertEquals(found.perSegment[1], [], "the silent segment contributes nothing");
  assertEquals(found.offsets, [0, 1, 1], "offsets count the hits before each segment");
});

Deno.test("the find bar's match number resolves to the segment that holds it", () => {
  const found = findMatches(searchableSegments(TRANSCRIPT), "test");

  assertEquals(segmentOfMatch(found, 0), 0, "the first hit is in the opening segment");
  assertEquals(segmentOfMatch(found, 1), 2, "the second hit skips the segment without hits");
  assertEquals(segmentOfMatch(found, 2), 2, "the third hit is the second one in that segment");
  assertEquals(segmentOfMatch(found, 3), -1, "a hit past the end resolves to nothing");
});

// This is what lets the video follow the find bar: the match number has to map
// back to a timestamp, not just to a highlighted word.
Deno.test("stepping to a match yields the moment it was spoken", () => {
  const found = findMatches(searchableSegments(TRANSCRIPT), "test");
  const seconds = TRANSCRIPT[segmentOfMatch(found, 1)].start_seconds;

  assertEquals(seconds, 120, "the second occurrence starts at the third segment");
});

Deno.test("matching ignores case while the marks keep the original text", () => {
  const found = findMatches(searchableSegments(TRANSCRIPT), "test");
  const parts = splitOnMatches(TRANSCRIPT[0].text, found.perSegment[0], 4, found.offsets[0]);
  const marked = parts.filter((part) => part.matchIndex !== null);

  assertEquals(marked.length, 1, "one mark in the opening segment");
  assertEquals(marked[0].text, "Test", "the mark carries the capital the speaker's slide had");
  assertEquals(
    parts.map((part) => part.text).join(""),
    TRANSCRIPT[0].text,
    "the split is lossless",
  );
});

Deno.test("an empty term matches nothing rather than everything", () => {
  const found = findMatches(searchableSegments(TRANSCRIPT), "");

  assertEquals(found.total, 0, "no hits");
  assertEquals(
    splitOnMatches(TRANSCRIPT[0].text, [], 0, 0),
    [{ text: TRANSCRIPT[0].text, matchIndex: null }],
    "the segment renders as one unmarked run",
  );
});

// A segment whose lowercase form is longer than the original would have its
// marks cut at the wrong offsets. Dropping it from the search costs a hit;
// slicing it anyway costs mangled words and a counter that lies.
Deno.test("a segment that lowercases to a different length is skipped, not mis-sliced", () => {
  const tricky = [segment(0, "İstanbul en de test"), segment(60, "gewoon een test")];
  const searchable = searchableSegments(tricky);

  assert(searchable[0] === null, "the length-shifting segment is excluded");
  assert(typeof searchable[1] === "string", "its neighbour is still searchable");

  const found = findMatches(searchable, "test");
  assertEquals(found.total, 1, "only the safe segment reports a hit");
  assertEquals(segmentOfMatch(found, 0), 1, "and the playhead points at that one");
});

Deno.test("overlapping candidates advance past the whole match", () => {
  const repeated = [segment(0, "aaaa")];
  const found = findMatches(searchableSegments(repeated), "aa");

  assertEquals(found.perSegment[0], [0, 2], "matches do not overlap each other");
});
