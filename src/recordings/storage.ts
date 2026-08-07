import { currentDerivationVersion } from "../pipeline/versioning.ts";
import { storagePrefixForSourceInfo } from "../storage/prefixes.ts";
import type { ObjectStorageClient } from "../storage/s3.ts";
import type { RecordingEntity } from "../types.ts";

/** The parsed timeline of one recording, as stored in object storage.
 *
 * Kept out of the entity payload for the same reason document markdown is: the
 * payload is stored per search hit, and a transcript is ~30 KB. */
export interface StoredTranscript {
  segments: RecordingEntity["segments"];
  chapters: RecordingEntity["chapters"];
  speakers: RecordingEntity["speakers"];
}

function recordingPrefix(recording: RecordingEntity): string {
  // Built from the shared root helper so a purge of this source is guaranteed
  // to cover these keys.
  return `${storagePrefixForSourceInfo("recordings", recording.source_info)}${recording.id}`;
}

export function transcriptKey(recording: RecordingEntity): string {
  return `${recordingPrefix(recording)}/${currentDerivationVersion()}/transcript.json`;
}

/** Where the untouched supplier SRT/VTT is kept, so a better parser later does
 * not mean going back to the supplier. */
export function rawTranscriptKey(recording: RecordingEntity, extension: string): string {
  return `${recordingPrefix(recording)}/original.${extension}`;
}

/** Writes the timeline and returns the recording with its storage pointers set.
 *
 * Without storage configured the recording keeps its in-memory segments — the
 * Quickwit projection still indexes the spoken text, only the detail view has
 * nothing to read back. That is a degraded mode, not a failure.  */
export async function storeTranscript(
  recording: RecordingEntity,
  options: { storage?: ObjectStorageClient; rawTranscript?: string; rawExtension?: string },
): Promise<RecordingEntity> {
  const { storage } = options;
  if (!storage || !recording.segments?.length) {
    return recording;
  }

  const key = transcriptKey(recording);
  const body: StoredTranscript = {
    segments: recording.segments,
    chapters: recording.chapters,
    speakers: recording.speakers,
  };

  await storage.putObject(key, new TextEncoder().encode(JSON.stringify(body)), {
    contentType: "application/json",
  });

  let rawKey: string | undefined;
  if (options.rawTranscript) {
    rawKey = rawTranscriptKey(recording, options.rawExtension ?? "srt");
    await storage.putObject(rawKey, new TextEncoder().encode(options.rawTranscript), {
      contentType: "text/plain; charset=utf-8",
    });
  }

  return {
    ...recording,
    derived_content: {
      ...recording.derived_content,
      transcript_key: key,
      raw_transcript_key: rawKey,
    },
  };
}

export async function readTranscript(
  storage: ObjectStorageClient,
  key: string,
): Promise<StoredTranscript | undefined> {
  const text = await storage.getObjectText(key);
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text) as StoredTranscript;
  } catch {
    // A truncated or half-written object must not take the whole meeting
    // detail down with it; the agenda and the player are still useful.
    return undefined;
  }
}
