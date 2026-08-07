import { canonicalAgendaItemId, canonicalRecordingId } from "../ids.ts";
import { notubizMediaUrl } from "./client.ts";
import { buildSegments, parseTranscriptCues } from "../recordings/transcript.ts";
import type {
  MeetingAgendaItem,
  MeetingEntity,
  NotubizMedia,
  NotubizSourceDefinition,
  RecordingChapter,
  RecordingEntity,
  RecordingSpeaker,
} from "../types.ts";

/** Offsets of every agenda item in the raw meeting response, keyed by the
 * canonical agenda item id.
 *
 * Notubiz publishes `start_offset`/`end_offset` (seconds into the recording) on
 * the agenda items of the meeting detail we already fetch, so chapters cost no
 * extra API call. They are strings in the payload, and `"0"` is a real offset
 * rather than a missing one. */
function collectAgendaOffsets(
  source: NotubizSourceDefinition,
  agendaItems: unknown,
): Map<string, { start: number; end?: number }> {
  const offsets = new Map<string, { start: number; end?: number }>();

  const walk = (items: unknown): void => {
    if (!Array.isArray(items)) {
      return;
    }
    for (const item of items) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const record = item as Record<string, unknown>;
      const id = record.id;
      const start = Number(record.start_offset);
      if ((typeof id === "number" || typeof id === "string") && Number.isFinite(start)) {
        const end = Number(record.end_offset);
        offsets.set(canonicalAgendaItemId(source, id), {
          start,
          end: Number.isFinite(end) ? end : undefined,
        });
      }
      walk(record.agenda_items);
    }
  };

  walk(agendaItems);
  return offsets;
}

/** Agenda items that were placed on the recording's timeline, in play order.
 *
 * Titles come from the already-normalized meeting rather than from the raw
 * payload, so chapter titles and agenda titles cannot drift apart. */
export function notubizChapters(
  source: NotubizSourceDefinition,
  meeting: MeetingEntity,
  rawMeeting: unknown,
): RecordingChapter[] {
  const record =
    rawMeeting && typeof rawMeeting === "object" ? (rawMeeting as Record<string, unknown>) : {};
  const offsets = collectAgendaOffsets(source, record.agenda_items);
  if (offsets.size === 0) {
    return [];
  }

  const chapters: RecordingChapter[] = [];
  const walk = (items?: MeetingAgendaItem[]): void => {
    for (const item of items ?? []) {
      const offset = offsets.get(item.id);
      // An offset with zero duration means the item was never discussed on
      // camera: the griffie parks the remainder of the agenda on the closing
      // second. Measured over 846 offsets, 9% are like this, in 22 of 61
      // meetings — Den Bosch even has an agenda item literally called "Niet
      // opgenomen". Keeping them would put a play button on points that jump
      // the viewer to a meaningless moment.
      const played = offset && (offset.end === undefined || offset.end > offset.start);
      if (offset && played && item.title) {
        chapters.push({
          start_seconds: offset.start,
          end_seconds: offset.end,
          title: item.number ? `${item.number} ${item.title}` : item.title,
          agenda_item: item.id,
        });
      }
      walk(item.agenda_items);
    }
  };
  walk(meeting.agenda);

  // Play order, not agenda order: these two genuinely differ in a quarter of
  // meetings (Den Bosch has "Opening" as agenda item 32 at second 0), and this
  // list is the video's timeline. The agenda keeps its own order.
  return chapters.sort((left, right) => left.start_seconds - right.start_seconds);
}

/** Derives the seekable HLS URL from the Wowza coordinates in the media record.
 *
 * `media/download` is not usable for anything that jumps to a timestamp: it
 * answers a Range request with a plain 200 and no content-length, so a browser
 * can only play it from the start. The same file is served by Wowza as HLS over
 * HTTPS, which does seek — `rtmp://wowza1.notubiz.nl/nbvod/_definst_` plus
 * stream name "Nunspeet/bestanden/x.mp4" becomes
 * `https://wowza1.notubiz.nl/nbvod/_definst_/mp4:Nunspeet/bestanden/x.mp4/playlist.m3u8`. */
export function notubizStreamUrl(media: NotubizMedia): string | undefined {
  const streamer = media.streamer?.trim();
  const streamName = media.stream_name?.trim();
  if (!streamer || !streamName) {
    return undefined;
  }

  const match = streamer.match(/^rtmps?:\/\/([^/]+)\/(.+)$/i);
  if (!match) {
    return undefined;
  }

  const [, host, application] = match;
  // Only the path segments are escaped; the "mp4:" prefix is a Wowza selector,
  // not part of the file name.
  const path = streamName.split("/").map(encodeURIComponent).join("/");
  return `https://${host}/${application}/mp4:${path}/playlist.m3u8`;
}

/** A recording carries its meeting's name verbatim.
 *
 * It used to be prefixed with "Video"/"Audio", which read fine in isolation but
 * wrong where it actually surfaces: a transcript match is presented as its
 * meeting in search, so the prefix turned an ordinary meeting result into
 * "Video Vergadering 2026-04-01". The medium is already in `media_type` and
 * `classification`. */
function recordingName(meeting: MeetingEntity): string {
  return meeting.name;
}

/** Builds the Recording entity for one Notubiz media file.
 *
 * `transcript` is the raw SRT when the meeting has one. Speakers are optional:
 * they only exist in the public portal HTML, and a recording without them is
 * still fully searchable. */
export function normalizeNotubizRecording(
  source: NotubizSourceDefinition,
  meeting: MeetingEntity,
  rawMeeting: unknown,
  media: NotubizMedia,
  options: { transcript?: string; speakers?: RecordingSpeaker[] } = {},
): RecordingEntity {
  const speakers = options.speakers ?? [];
  const cues = options.transcript ? parseTranscriptCues(options.transcript) : [];
  const segments = buildSegments(cues, { speakers });
  const chapters = notubizChapters(source, meeting, rawMeeting);

  return {
    id: canonicalRecordingId(source, media.id),
    type: "Recording",
    name: recordingName(meeting),
    classification: [media.media_type === "audio" ? "Audio" : "Video"],
    media_type: media.media_type === "audio" ? "audio" : "video",
    meeting: meeting.id,
    // The recording usually starts a few minutes before the gavel, so the
    // meeting's own start_date is the honest date to sort on rather than a
    // media timestamp we would have to guess at.
    start_date: meeting.start_date,
    duration_seconds: cues.length > 0 ? Math.round(cues[cues.length - 1].end_seconds) : undefined,
    platform: "notubiz",
    // The portal page, not the media file: media URLs are unstable and huge,
    // the portal page is where a visitor can actually watch.
    player_url:
      typeof (meeting.raw as Record<string, unknown> | undefined)?.url === "string"
        ? ((meeting.raw as Record<string, unknown>).url as string)
        : undefined,
    // Notubiz publishes this without a scheme and with raw spaces in the query
    // string, so it has to be normalized before it is stored — otherwise we
    // hand consumers something that is not a URL.
    media_url: media.download_url ? notubizMediaUrl(media.download_url) : undefined,
    stream_url: notubizStreamUrl(media),
    content_type: media.media_type === "audio" ? "audio/mpeg" : "video/mp4",
    size_in_bytes: media.file_size,
    transcript_language: segments.length > 0 ? "nl" : undefined,
    // Notubiz publishes machine transcription only; Company Webcast is the one
    // that also has human-corrected tracks.
    transcript_kind: segments.length > 0 ? "asr" : undefined,
    segments: segments.length > 0 ? segments : undefined,
    chapters: chapters.length > 0 ? chapters : undefined,
    speakers: speakers.length > 0 ? speakers : undefined,
    derived_content: {
      segment_count: segments.length,
      chapter_count: chapters.length,
      speaker_count: speakers.length,
    },
    organization: meeting.organization,
    last_discussed_at: meeting.start_date,
    source_info: meeting.source_info,
    raw: media,
  };
}
