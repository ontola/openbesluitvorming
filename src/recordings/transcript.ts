import type { RecordingSegment, RecordingSpeaker } from "../types.ts";

/** One subtitle cue, as the supplier publishes it. */
export interface TranscriptCue {
  start_seconds: number;
  end_seconds: number;
  text: string;
}

/** Cues are 2-4 seconds long. Merging them into blocks of roughly this length
 * keeps a three-hour meeting at a few hundred readable segments instead of
 * thousands of fragments, which matters both for the reading view and for the
 * eventual per-segment search projection. */
const DEFAULT_TARGET_SECONDS = 120;

/** Anything longer than this between two cues is silence, not a pause in the
 * same thought, so the block is cut there even if it is still short. */
const DEFAULT_GAP_SECONDS = 8;

function parseTimestamp(value: string): number | undefined {
  // SRT uses "00:00:10,140"; WebVTT uses "0:05:50.201" and may omit the hour.
  const match = value.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
  if (!match) {
    return undefined;
  }

  const [, hours, minutes, seconds, fraction] = match;
  return (
    Number(hours ?? 0) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number(fraction.padEnd(3, "0")) / 1000
  );
}

/** Parses SRT (Notubiz) and WebVTT (Company Webcast) into cues.
 *
 * One parser for both on purpose: they differ in the header, the cue numbering
 * and the decimal separator, and in nothing else that matters to us. */
export function parseTranscriptCues(input: string): TranscriptCue[] {
  const cues: TranscriptCue[] = [];
  const normalized = input.replaceAll("\r\n", "\n").replaceAll("\r", "\n");

  for (const block of normalized.split(/\n\s*\n/)) {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      continue;
    }

    const arrowIndex = lines.findIndex((line) => line.includes("-->"));
    if (arrowIndex === -1) {
      // The WEBVTT header, a NOTE block, or a stray cue number.
      continue;
    }

    const [rawStart, rawEnd] = lines[arrowIndex].split("-->");
    const start = parseTimestamp(rawStart ?? "");
    // WebVTT allows cue settings after the end time ("00:01.000 align:start").
    const end = parseTimestamp((rawEnd ?? "").trim().split(/\s+/)[0] ?? "");
    if (start === undefined || end === undefined) {
      continue;
    }

    const text = lines
      .slice(arrowIndex + 1)
      .join(" ")
      // Subtitles are wrapped mid-sentence for display; the ellipsis at a line
      // break is a continuation marker, not punctuation we want to keep.
      .replaceAll(/\.\.\.$/g, "")
      .replaceAll(/\s+/g, " ")
      .trim();
    if (!text) {
      continue;
    }

    cues.push({ start_seconds: start, end_seconds: Math.max(end, start), text });
  }

  return cues;
}

function speakerAt(speakers: RecordingSpeaker[], seconds: number): string | undefined {
  const match = speakers.find(
    (speaker) =>
      seconds >= speaker.start_seconds &&
      (speaker.end_seconds === undefined || seconds < speaker.end_seconds),
  );
  return match?.person ?? match?.name;
}

/** Merges cues into segments, splitting on a speaker change where we know one.
 *
 * A block that runs across a speaker change would be attributed to whoever
 * happened to start it, which is worse than a short segment: it puts words in
 * someone's mouth. */
export function buildSegments(
  cues: TranscriptCue[],
  options: {
    speakers?: RecordingSpeaker[];
    targetSeconds?: number;
    maxGapSeconds?: number;
  } = {},
): RecordingSegment[] {
  const speakers = options.speakers ?? [];
  const target = options.targetSeconds ?? DEFAULT_TARGET_SECONDS;
  const maxGap = options.maxGapSeconds ?? DEFAULT_GAP_SECONDS;

  const segments: RecordingSegment[] = [];
  let current: RecordingSegment | undefined;

  for (const cue of cues) {
    const speaker = speakers.length > 0 ? speakerAt(speakers, cue.start_seconds) : undefined;
    const tooLong = current && cue.end_seconds - current.start_seconds >= target;
    const afterSilence = current && cue.start_seconds - current.end_seconds >= maxGap;
    const speakerChanged = current && speaker !== current.speaker;

    if (!current || tooLong || afterSilence || speakerChanged) {
      current = {
        start_seconds: cue.start_seconds,
        end_seconds: cue.end_seconds,
        text: cue.text,
        speaker,
      };
      segments.push(current);
      continue;
    }

    current.end_seconds = cue.end_seconds;
    current.text = `${current.text} ${cue.text}`;
  }

  // `speaker: undefined` is noise in the stored JSON when nothing resolved.
  return segments.map((segment) =>
    segment.speaker === undefined
      ? {
          start_seconds: segment.start_seconds,
          end_seconds: segment.end_seconds,
          text: segment.text,
        }
      : segment,
  );
}
