// Builds one Notubiz Recording from the live API and writes a self-contained
// HTML preview: the video next to its chapters and its transcript, where
// clicking a line seeks the player.
//
// This is a look-at-it tool, not part of the ingest path. It exercises the real
// client and normalizer so what you see is what the extractor will produce.
//
// Usage:
//   deno run -A scripts/preview_recording.ts <source-key> [--meeting <id>]
//   deno run -A scripts/preview_recording.ts haarlem --from 2026-04-01 --to 2026-05-31
//   deno run -A scripts/preview_recording.ts nunspeet --out /tmp/opname.html --open
//
// Without --meeting it scans the date range (default: the last three months)
// and picks the first meeting that has both media and a transcript.

import { NotubizClient } from "../src/notubiz/client.ts";
import { normalizeNotubizRecording } from "../src/notubiz/recordings.ts";
import { normalizeNotubizMeeting } from "../src/notubiz/normalize.ts";
import { getNotubizSource } from "../src/sources/index.ts";
import type { MeetingEntity, NotubizMedia, RecordingEntity } from "../src/types.ts";

function arg(name: string): string | undefined {
  const index = Deno.args.indexOf(`--${name}`);
  return index === -1 ? undefined : Deno.args[index + 1];
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderHtml(recording: RecordingEntity, meeting: MeetingEntity): string {
  // Prefer the HLS stream: the plain mp4 download ignores Range requests, so
  // clicking a timestamp on it does nothing. Chrome has no native HLS, hence
  // hls.js from a CDN — acceptable in a local preview tool, and the reason this
  // page is not the same thing as the real player in the app.
  const streamUrl = recording.stream_url;
  const mediaUrl = recording.media_url ?? "";
  const chapters = (recording.chapters ?? [])
    .map(
      (chapter) =>
        `<li><button data-seek="${chapter.start_seconds}"><span class="t">${formatClock(
          chapter.start_seconds,
        )}</span> ${escapeHtml(chapter.title)}</button></li>`,
    )
    .join("\n");

  const segments = (recording.segments ?? [])
    .map(
      (segment) =>
        `<p class="seg" data-start="${segment.start_seconds}" data-end="${segment.end_seconds}">` +
        `<button data-seek="${segment.start_seconds}" class="t">${formatClock(
          segment.start_seconds,
        )}</button> ` +
        `<span>${escapeHtml(segment.text)}</span></p>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<title>${escapeHtml(recording.name)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 system-ui, sans-serif; margin: 0; padding: 1.5rem; max-width: 1200px; }
  h1 { font-size: 1.3rem; margin: 0 0 .25rem; }
  .meta { color: #6b7280; font-size: .9rem; margin-bottom: 1.25rem; }
  .meta code { font-size: .82rem; }
  .layout { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); gap: 1.5rem; align-items: start; }
  video { width: 100%; border-radius: .6rem; background: #000; }
  .panel { border: 1px solid #d1d5db; border-radius: .6rem; padding: .75rem 1rem; max-height: 78vh; overflow: auto; }
  h2 { font-size: .85rem; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; margin: 0 0 .5rem; }
  ul { list-style: none; margin: 0 0 1rem; padding: 0; }
  li button { display: block; width: 100%; text-align: left; background: none; border: 0; padding: .3rem .2rem; font: inherit; color: inherit; cursor: pointer; border-radius: .3rem; }
  li button:hover { background: rgba(127,127,127,.12); }
  .t { font-variant-numeric: tabular-nums; color: #2563eb; background: none; border: 0; font: inherit; cursor: pointer; padding: 0; }
  .seg { margin: 0 0 .55rem; padding: .25rem .3rem; border-radius: .35rem; }
  .seg.active { background: rgba(37,99,235,.14); }
  mark { background: #fde68a; }
  .search { width: 100%; padding: .45rem .6rem; margin-bottom: .75rem; border: 1px solid #d1d5db; border-radius: .4rem; font: inherit; }
  .warn { color: #b45309; font-size: .85rem; margin: .5rem 0 0; }
</style>
</head>
<body>
<h1>${escapeHtml(recording.name)}</h1>
<div class="meta">
  ${escapeHtml(meeting.source_info.source)} &middot; ${escapeHtml(meeting.start_date ?? "")}
  &middot; ${recording.derived_content?.segment_count ?? 0} spraakfragmenten
  &middot; ${recording.derived_content?.chapter_count ?? 0} agendapunten op de tijdlijn
  &middot; <code>${escapeHtml(recording.id)}</code>
</div>
<div class="layout">
  <div>
    <video id="player" controls preload="metadata"${
      streamUrl ? "" : ` src="${escapeHtml(mediaUrl)}"`
    }></video>
    ${streamUrl ? "" : '<p class="warn">Geen HLS-stream: dit mp4-bestand ondersteunt geen Range-requests, dus springen naar een tijdstip werkt niet.</p>'}
    <div class="panel" style="margin-top:1rem">
      <h2>Agendapunten</h2>
      <ul>${chapters || "<li>Geen tijdlijn beschikbaar</li>"}</ul>
    </div>
  </div>
  <div class="panel">
    <h2>Gesproken tekst</h2>
    <input class="search" id="q" placeholder="Zoek in het transcript…" autocomplete="off">
    <div id="segments">${segments || "<p>Geen transcript beschikbaar</p>"}</div>
  </div>
</div>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js"></script>
<script>
  const player = document.getElementById("player");
  const streamUrl = ${streamUrl ? JSON.stringify(streamUrl) : "null"};
  if (streamUrl) {
    if (player.canPlayType("application/vnd.apple.mpegurl")) {
      player.src = streamUrl;
    } else if (window.Hls && window.Hls.isSupported()) {
      const hls = new window.Hls();
      hls.loadSource(streamUrl);
      hls.attachMedia(player);
    } else {
      player.src = ${JSON.stringify(mediaUrl)};
    }
  }

  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-seek]");
    if (!target) return;
    player.currentTime = Number(target.dataset.seek);
    player.play();
  });

  const segments = [...document.querySelectorAll(".seg")];
  player.addEventListener("timeupdate", () => {
    const now = player.currentTime;
    for (const segment of segments) {
      const active = now >= Number(segment.dataset.start) && now < Number(segment.dataset.end);
      segment.classList.toggle("active", active);
      if (active && !segment.dataset.scrolled) {
        segment.scrollIntoView({ block: "center", behavior: "smooth" });
        segments.forEach((other) => delete other.dataset.scrolled);
        segment.dataset.scrolled = "1";
      }
    }
  });

  document.getElementById("q").addEventListener("input", (event) => {
    const term = event.target.value.trim().toLowerCase();
    for (const segment of segments) {
      const span = segment.querySelector("span");
      const text = span.textContent;
      segment.style.display = !term || text.toLowerCase().includes(term) ? "" : "none";
      span.innerHTML = term
        ? text.replace(new RegExp("(" + term.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&") + ")", "gi"), "<mark>$1</mark>")
        : text;
    }
  });
</script>
</body>
</html>`;
}

async function findMeetingWithMedia(
  client: NotubizClient,
  organizationId: number,
  dateFrom: string,
  dateTo: string,
): Promise<{ meetingId: number; media: NotubizMedia }> {
  let page = 1;
  const withoutTranscript: Array<{ meetingId: number; media: NotubizMedia }> = [];

  while (page <= 5) {
    const response = (await client.listEvents(organizationId, dateFrom, dateTo, page)) as {
      events?: Array<Record<string, unknown>>;
      pagination?: { has_more_pages?: boolean };
    };
    const events = (response.events ?? []).filter((event) => event.type === "meeting");

    // `live: true` marks the meetings that were streamed. Measured over eight
    // organisations it predicts media with 52/53 precision, so checking those
    // first finds a usable meeting in a handful of calls instead of dozens.
    const ordered = [...events].sort((left, right) => Number(right.live) - Number(left.live));

    for (const event of ordered) {
      const meetingId = event.id;
      if (typeof meetingId !== "number") {
        continue;
      }
      const media = await client.listMedia(meetingId);
      if (media.length === 0) {
        continue;
      }
      const withSubtitles = media.find((item) => item.subtitles);
      if (withSubtitles) {
        return { meetingId, media: withSubtitles };
      }
      withoutTranscript.push({ meetingId, media: media[0] });
    }

    if (!response.pagination?.has_more_pages) {
      break;
    }
    page += 1;
  }

  if (withoutTranscript.length > 0) {
    console.warn("[preview] no meeting with a transcript found; falling back to media only");
    return withoutTranscript[0];
  }

  throw new Error(`No meeting with media between ${dateFrom} and ${dateTo}`);
}

async function main(): Promise<void> {
  const sourceKey = Deno.args[0];
  if (!sourceKey || sourceKey.startsWith("--")) {
    console.error("Usage: deno run -A scripts/preview_recording.ts <source-key> [--meeting <id>]");
    Deno.exit(1);
  }

  const source = getNotubizSource(sourceKey);
  const client = new NotubizClient();
  const dateFrom = arg("from") ?? isoDaysAgo(90);
  const dateTo = arg("to") ?? isoDaysAgo(0);

  let meetingId: number;
  let media: NotubizMedia;

  const explicit = arg("meeting");
  if (explicit) {
    meetingId = Number(explicit);
    const list = await client.listMedia(meetingId);
    if (list.length === 0) {
      throw new Error(`Meeting ${meetingId} has no media`);
    }
    media = list.find((item) => item.subtitles) ?? list[0];
  } else {
    console.log(`[preview] scanning ${sourceKey} between ${dateFrom} and ${dateTo}…`);
    ({ meetingId, media } = await findMeetingWithMedia(
      client,
      source.notubizOrganizationId,
      dateFrom,
      dateTo,
    ));
  }

  console.log(`[preview] meeting ${meetingId}, media ${media.id} (${media.media_type})`);

  const attributes = await client.getOrganizationAttributes(source.notubizOrganizationId);
  const detail = (await client.getMeeting(meetingId)) as { meeting?: unknown };
  if (!detail.meeting) {
    throw new Error(`Meeting ${meetingId} returned no detail`);
  }
  const meeting = normalizeNotubizMeeting(source, attributes, detail.meeting);

  let transcript: string | undefined;
  if (media.subtitles_url) {
    console.log("[preview] downloading transcript…");
    transcript = await client.downloadSubtitles(media);
  }

  const recording = normalizeNotubizRecording(source, meeting, detail.meeting, media, {
    transcript,
  });

  console.log(
    `[preview] ${recording.derived_content?.segment_count ?? 0} segments, ` +
      `${recording.derived_content?.chapter_count ?? 0} chapters, ` +
      `${recording.duration_seconds ?? 0}s of speech`,
  );

  const outPath = arg("out") ?? `/tmp/woozi-recording-${meetingId}.html`;
  await Deno.writeTextFile(outPath, renderHtml(recording, meeting));
  console.log(`[preview] wrote ${outPath}`);

  if (Deno.args.includes("--open")) {
    await new Command("open", { args: [outPath] }).output();
  }
}

const { Command } = Deno;

if (import.meta.main) {
  await main();
}
