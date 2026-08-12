import type { RecordingSegment } from "../../src/types.ts";

/** Every occurrence of one term in one transcript. */
export interface TranscriptMatches {
  /** Match start offsets within each segment, in reading order. */
  perSegment: number[][];
  /** Running match count of the segments before each one, so every occurrence
   * in the transcript gets a stable number and the find bar can point at
   * exactly one of them. */
  offsets: number[];
  total: number;
}

export const NO_TRANSCRIPT_MATCHES: TranscriptMatches = {
  perSegment: [],
  offsets: [],
  total: 0,
};

/** Lowercases the transcript once, so a keystroke costs one pass and not one
 * per thing that needs the positions.
 *
 * `toLowerCase` can change a string's length (İ becomes two code points), and
 * the marks are cut out of the *original* text by index. A segment where the
 * two disagree is dropped from the search (`null`) instead of being sliced at
 * the wrong offset: a missed hit in one paragraph beats mangled words and a
 * counter that disagrees with what is on screen. */
export function searchableSegments(segments: RecordingSegment[]): Array<string | null> {
  return segments.map((segment) => {
    const lower = segment.text.toLowerCase();
    return lower.length === segment.text.length ? lower : null;
  });
}

/** Finds every occurrence in one pass over the transcript.
 *
 * Worth doing as one pass: the counter, the find bar's offsets and the marks
 * all need the same positions, and computing them separately meant lowercasing
 * the whole transcript three times per keystroke — a few hundred kilobytes on
 * a three-hour meeting. That only got away with it because the find bar started
 * empty; a query arriving pre-filled from the search results pays the cost on
 * open, for every recording on the page at once.
 *
 * `needle` must already be lowercased — it comes straight from the input on
 * every keystroke, while the haystacks are cached. */
export function findMatches(haystacks: Array<string | null>, needle: string): TranscriptMatches {
  if (!needle) {
    return NO_TRANSCRIPT_MATCHES;
  }

  const perSegment: number[][] = [];
  const offsets: number[] = [];
  let total = 0;

  for (const haystack of haystacks) {
    offsets.push(total);
    const positions: number[] = [];
    if (haystack) {
      let index = haystack.indexOf(needle);
      while (index !== -1) {
        positions.push(index);
        index = haystack.indexOf(needle, index + needle.length);
      }
    }
    perSegment.push(positions);
    total += positions.length;
  }

  return { perSegment, offsets, total };
}

/** Splits a segment on its matches so one can be wrapped in a `<mark>` without
 * ever putting supplier text through `{@html}`. Positions index the original
 * text directly — see `searchableSegments` for why that holds. */
export function splitOnMatches(
  text: string,
  positions: number[],
  length: number,
  offset: number,
): Array<{ text: string; matchIndex: number | null }> {
  if (positions.length === 0 || length === 0) {
    return [{ text, matchIndex: null }];
  }

  const parts: Array<{ text: string; matchIndex: number | null }> = [];
  let index = 0;

  positions.forEach((found, seen) => {
    if (found > index) {
      parts.push({ text: text.slice(index, found), matchIndex: null });
    }
    parts.push({ text: text.slice(found, found + length), matchIndex: offset + seen });
    index = found + length;
  });

  if (index < text.length) {
    parts.push({ text: text.slice(index), matchIndex: null });
  }

  return parts;
}

/** The segment a given occurrence falls in, so the playhead can follow the find
 * bar. Returns -1 when the transcript holds no such occurrence. */
export function segmentOfMatch(found: TranscriptMatches, match: number): number {
  return found.perSegment.findIndex(
    (positions, index) =>
      positions.length > 0 &&
      match >= found.offsets[index] &&
      match < found.offsets[index] + positions.length,
  );
}
