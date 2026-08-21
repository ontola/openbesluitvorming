<script lang="ts">
  import { createEventDispatcher, onDestroy, tick } from "svelte";
  import type { MeetingRecording } from "../../src/types.ts";
  import {
    findMatches,
    searchableSegments,
    segmentOfMatch,
    splitOnMatches,
  } from "./transcript_search.ts";

  export let recording: MeetingRecording;
  /** The site-wide search term that brought the reader here. When it occurs in
   * the spoken word the find bar opens on it and the player is cued to the
   * first hit — the transcript is the only place that match is visible, and
   * hunting for it by hand in a three-hour meeting is not a search result. */
  export let initialQuery = "";

  const dispatch = createEventDispatcher<{ transcriptmatch: { seconds: number } }>();

  let videoEl: HTMLVideoElement | undefined;
  let hls: { destroy: () => void } | undefined;
  let attachedTo: string | undefined;
  let currentTime = 0;
  let query = "";
  let transcriptEl: HTMLElement | undefined;
  let followPlayhead = true;
  // Search is a button until it is wanted: the transcript is for reading, and a
  // permanent input box costs a line of height on every meeting to serve the
  // minority of visits that search.
  let searchOpen = false;
  let searchEl: HTMLInputElement | undefined;
  let activeMatch = 0;
  let pendingSeek: { seconds: number; play: boolean } | undefined;
  /** Which (recording, incoming query) pair the find bar was already primed
   * for, so re-renders don't re-open a bar the reader just closed. */
  let primedFor: string | undefined;

  async function openSearch(): Promise<void> {
    searchOpen = true;
    await tick();
    searchEl?.focus();
  }

  function closeSearch(): void {
    searchOpen = false;
    query = "";
    activeMatch = 0;
    followPlayhead = true;
  }

  /** The plain media file is not seekable on every supplier — Notubiz answers a
   * Range request with a whole 200 — so the adaptive stream is what makes
   * jumping to an agenda item work at all. Safari plays HLS natively; every
   * other browser needs hls.js, which is loaded only when there is a stream to
   * play so the chunk stays out of the initial bundle. */
  async function attach(element: HTMLVideoElement, source: MeetingRecording): Promise<void> {
    if (attachedTo === source.id) {
      return;
    }
    attachedTo = source.id;
    hls?.destroy();
    hls = undefined;

    const streamUrl = source.stream_url;
    if (!streamUrl) {
      element.src = source.media_url ?? "";
      return;
    }

    if (element.canPlayType("application/vnd.apple.mpegurl")) {
      element.src = streamUrl;
      return;
    }

    const { default: Hls } = await import("hls.js");
    if (!Hls.isSupported()) {
      element.src = source.media_url ?? "";
      return;
    }

    const instance = new Hls({ enableWorker: true });
    instance.loadSource(streamUrl);
    instance.attachMedia(element);
    hls = instance;
  }

  /** Moves the playhead, holding the jump until there is a timeline to jump in.
   *
   * `currentTime` is silently dropped while the element is still at
   * HAVE_NOTHING, which is exactly the state a search-driven cue arrives in:
   * it is computed as the panel mounts, while hls.js is still parsing the
   * manifest. Held jumps are applied on `loadedmetadata`.
   *
   * `play` separates the two callers: a click on a timestamp or an agenda item
   * is a request to watch, while landing on a search hit is not — starting
   * audio on its own the moment a meeting opens is a jump scare, not a
   * feature. */
  function moveTo(seconds: number, play: boolean): void {
    if (!videoEl) {
      return;
    }
    followPlayhead = true;
    if (videoEl.readyState === HTMLMediaElement.HAVE_NOTHING) {
      pendingSeek = { seconds, play };
      return;
    }
    pendingSeek = undefined;
    videoEl.currentTime = seconds;
    if (play) {
      void videoEl.play();
    }
  }

  function applyPendingSeek(): void {
    const held = pendingSeek;
    pendingSeek = undefined;
    if (held) {
      moveTo(held.seconds, held.play);
    }
  }

  /** Bound by the parent so the agenda can drive the player: the agenda item
   * is where a reader decides to jump, and it lives outside this component. */
  export function seek(seconds: number): void {
    moveTo(seconds, true);
  }

  function hostnameOf(url?: string): string {
    if (!url) {
      return "";
    }
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  }

  function formatClock(seconds: number): string {
    const total = Math.max(0, Math.round(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const pad = (value: number) => String(value).padStart(2, "0");
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
  }

  function cueToActiveMatch(play: boolean): void {
    const index = segmentOfMatch(matches, activeMatch);
    if (index >= 0) {
      moveTo(segments[index].start_seconds, play);
    }
  }

  function stepMatch(delta: number): void {
    if (matchCount === 0) {
      return;
    }
    // Wrapping is what a find bar does, and the alternative — stopping at the
    // last hit — leaves the reader guessing whether they reached the end or
    // the button broke.
    activeMatch = (activeMatch + delta + matchCount) % matchCount;
    // Stepping the find bar moves the video with it. A hit in the spoken word
    // is a moment, not a line of text, so "next hit" that left the playhead
    // behind would make the reader jump twice for every result.
    cueToActiveMatch(false);
  }

  /** Opens the find bar on the term the reader searched for, if the spoken
   * word actually contains it.
   *
   * Matches its own transcript rather than reading the reactive `searchable`
   * and `matches`: this decides whether to assign `query` at all, so it needs
   * the count for a term that has not been assigned yet — and it would
   * otherwise depend on the order Svelte happens to run two reactive blocks in.
   * It runs once per opened meeting, so the extra pass is free. */
  /** Waits out the current update before priming.
   *
   * `query` is the root of a chain of derived values — the term, the match
   * positions, the counter — that are all recomputed earlier in the very
   * update this runs in. Assigning it from inside that update leaves them
   * holding the previous value: the observed result was a find bar visibly
   * filled with the search term and a transcript with nothing marked in it. */
  async function primeOnce(id: string, incoming: string, segmentCount: number): Promise<void> {
    const key = `${id}\n${incoming}`;
    if (segmentCount === 0 || primedFor === key) {
      return;
    }
    primedFor = key;
    await tick();
    primeFromQuery(incoming);
  }

  function primeFromQuery(incoming: string): void {
    const trimmed = incoming.trim();
    if (!trimmed) {
      return;
    }

    const found = findMatches(searchableSegments(segments), trimmed.toLowerCase());
    if (found.total === 0) {
      return;
    }

    query = trimmed;
    searchOpen = true;
    activeMatch = 0;
    const index = found.perSegment.findIndex((positions) => positions.length > 0);
    moveTo(segments[index].start_seconds, false);
    dispatch("transcriptmatch", { seconds: segments[index].start_seconds });
  }

  function scrollToActiveMatch(): void {
    void tick().then(() => {
      transcriptEl
        ?.querySelector<HTMLElement>(`[data-match="${activeMatch}"]`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  $: if (videoEl && recording) {
    void attach(videoEl, recording);
  }

  /** Suppliers usually put the agenda number in the chapter title ("1 Opening
   * en vaststellen agenda"), which next to the key cap reads as the same digit
   * twice. Dropped only when the two agree: where play order and agenda order
   * differ — about a quarter of meetings — the title's number is the one the
   * agenda below uses, and losing it would leave the reader unable to line the
   * two up at all. */
  function chapterLabel(title: string, number: number): string {
    const match = title.match(/^(\d+)[.)]?\s+(.*)$/s);
    return match && Number(match[1]) === number ? match[2] : title;
  }

  /** The transcript is the timeline, so the agenda items are folded into it as
   * headings in play order. That is deliberately not the agenda's own order:
   * the two differ in about a quarter of meetings, and here the video decides.
   * The agenda tree keeps document order and carries the same timestamps. */
  function withChapterHeadings(
    list: typeof segments,
    chapters: MeetingRecording["chapters"],
  ): Array<
    | { kind: "chapter"; key: string; title: string; start: number; number: number }
    | { kind: "segment"; key: string; index: number; segment: (typeof list)[number] }
  > {
    const rows: Array<
      | { kind: "chapter"; key: string; title: string; start: number; number: number }
      | { kind: "segment"; key: string; index: number; segment: (typeof list)[number] }
    > = [];
    const pending = [...(chapters ?? [])].sort((a, b) => a.start_seconds - b.start_seconds);
    let next = 0;

    list.forEach((segment, index) => {
      while (next < pending.length && pending[next].start_seconds <= segment.start_seconds) {
        const chapter = pending[next];
        rows.push({
          kind: "chapter",
          key: `c${chapter.start_seconds}-${next}`,
          title: chapter.title,
          start: chapter.start_seconds,
          // The number the reader can type to jump here. Play order, which is
          // why it is numbered here and not in the agenda tree: the two differ
          // in about a quarter of meetings and the keyboard follows the video.
          number: next + 1,
        });
        next += 1;
      }
      rows.push({ kind: "segment", key: `s${segment.start_seconds}`, index, segment });
    });

    // Chapters that start after the last transcribed word — a closing item
    // discussed once the subtitles stop, or a transcript that ends early — have
    // no segment to be inserted before. Appending them keeps the numbering
    // continuous, which is what the number keys address; dropping them made the
    // last agenda item unreachable from the transcript entirely.
    while (next < pending.length) {
      const chapter = pending[next];
      rows.push({
        kind: "chapter",
        key: `c${chapter.start_seconds}-${next}`,
        title: chapter.title,
        start: chapter.start_seconds,
        number: next + 1,
      });
      next += 1;
    }

    return rows;
  }

  /** Put each chapter and the segments under it in one block.
   *
   * Layout, not content. Every heading is `position: sticky`, and as flat
   * siblings they all shared one containing block spanning the whole
   * transcript — so each heading reached the top and stayed there, stacked on
   * the ones before it. That looked like a single bar only because a later
   * heading paints over an earlier one, which holds right up until a one-line
   * heading follows a two-line one and leaves its second line showing below.
   * A block per chapter ends each heading's containing block where the next
   * chapter starts, so it is carried off screen as the next one arrives.
   */
  function groupIntoChapters(
    list: ReturnType<typeof withChapterHeadings>,
  ): Array<{
    key: string;
    chapter: Extract<(typeof list)[number], { kind: "chapter" }> | null;
    segments: Array<Extract<(typeof list)[number], { kind: "segment" }>>;
  }> {
    const blocks: Array<{
      key: string;
      chapter: Extract<(typeof list)[number], { kind: "chapter" }> | null;
      segments: Array<Extract<(typeof list)[number], { kind: "segment" }>>;
    }> = [];

    for (const row of list) {
      if (row.kind === "chapter") {
        blocks.push({ key: row.key, chapter: row, segments: [] });
        continue;
      }
      if (blocks.length === 0) {
        // Whatever was said before the first agenda item was reached.
        blocks.push({ key: "opening", chapter: null, segments: [] });
      }
      blocks[blocks.length - 1].segments.push(row);
    }

    return blocks;
  }

  /** Where this recording is published. The portal page, not the media file:
   * the file URL carries an expiring signature at some suppliers and is a
   * multi-gigabyte download at others, while the portal page keeps working and
   * is the citable original. Falls back to the file only when the supplier
   * gives us no page. */
  $: sourceUrl = recording.player_url ?? recording.media_url;
  // Supplier URLs are not always well-formed; a bad one must cost the hostname
  // label, not the whole recording panel.
  $: sourceHost = hostnameOf(sourceUrl);

  $: term = query.trim();
  $: segments = recording.segments ?? [];
  // Searching steps through the transcript instead of filtering it. Filtering
  // threw away exactly what makes a transcript worth reading — who said what
  // around the hit — and it hid the agenda headings that say where you are.
  $: rows = withChapterHeadings(segments, recording.chapters);
  $: chapterBlocks = groupIntoChapters(rows);
  // Recomputed only when the transcript itself changes, not per keystroke.
  $: searchable = searchableSegments(segments);
  $: matches = findMatches(searchable, term.toLowerCase());
  $: matchCount = matches.total;
  // A new query starts at the first hit, and a shrinking result set must not
  // leave the cursor pointing past the end.
  $: if (term !== undefined && activeMatch >= matchCount) {
    activeMatch = 0;
  }
  $: activeIndex = segments.findIndex(
    (segment) => currentTime >= segment.start_seconds && currentTime < segment.end_seconds,
  );

  // Bring the current hit into view whenever it moves — both when stepping and
  // when a new term lands on its first hit. Doing this only in stepMatch left
  // typing a query highlighting something off screen.
  $: if (searchOpen && term && matchCount > 0 && activeMatch >= 0 && transcriptEl) {
    scrollToActiveMatch();
  }

  // Following the playhead is a convenience, not a hijack: as soon as the
  // reader searches or scrolls away it stops moving the viewport for them.
  $: if (followPlayhead && !term && activeIndex >= 0 && transcriptEl) {
    const node = transcriptEl.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    node?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  // Prime once per (recording, incoming term): re-running on every render would
  // re-open a find bar the reader had just closed, and closing it clears the
  // query, so it would fight them on every keystroke elsewhere on the page.
  $: void primeOnce(recording.id, initialQuery, segments.length);

  onDestroy(() => hls?.destroy());
</script>

<section class="recording">
  <div class="recording__media">
    <!-- svelte-ignore a11y-media-has-caption -->
    <video
      bind:this={videoEl}
      bind:currentTime
      class="recording__video"
      class:recording__video--audio={recording.media_type === "audio"}
      controls
      preload="metadata"
      on:loadedmetadata={applyPendingSeek}
    ></video>

    {#if sourceUrl}
      <p class="recording__source">
        <a href={sourceUrl} target="_blank" rel="noopener noreferrer">
          Bekijk bij de bron
          <span class="recording__source-host">{sourceHost}</span>
          <span aria-hidden="true">↗</span>
        </a>
      </p>
    {/if}
  </div>

  <div class="recording__transcript">
    <div class="recording__transcript-bar" class:recording__transcript-bar--open={searchOpen}>
      {#if term}
        <p class="recording__count" class:recording__count--empty={matchCount === 0}>
          {matchCount === 0 ? "geen" : `${activeMatch + 1} / ${matchCount}`}
        </p>
      {/if}
      {#if recording.transcript_kind === "asr" && !searchOpen}
        <span class="recording__warning">
          <button
            type="button"
            class="recording__search-toggle"
            aria-describedby={`${recording.id}-asr`}
            aria-label="Over deze uitgeschreven tekst"
          >
            <svg class="recording__icon" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 11v5" />
              <path d="M12 7.75h.01" />
            </svg>
          </button>
          <span class="recording__tooltip" id={`${recording.id}-asr`} role="tooltip">
            Automatisch uitgeschreven. Kan fouten bevatten — controleer bij de opname.
          </span>
        </span>
      {/if}
      {#if searchOpen}
        <input
          bind:this={searchEl}
          class="recording__search"
          type="search"
          bind:value={query}
          aria-label="Zoek in de videotulen"
          placeholder="Zoek in de videotulen…"
          autocomplete="off"
          on:keydown={(event) => {
            // The detail sheet binds Escape and the arrow keys on `document`
            // to close itself and to step through results. While someone is
            // typing in here those are keystrokes, not shortcuts: without this
            // guard, Escape throws the reader out of the meeting and a left
            // arrow jumps to a different entity mid-word.
            event.stopPropagation();
            if (event.key === "Escape") {
              closeSearch();
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              stepMatch(event.shiftKey ? -1 : 1);
            }
          }}
        />
        <button
          type="button"
          class="recording__search-toggle"
          aria-label="Vorige treffer"
          disabled={matchCount === 0}
          on:click={() => stepMatch(-1)}
        >
          <svg class="recording__icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M17 14l-5-5-5 5" />
          </svg>
        </button>
        <button
          type="button"
          class="recording__search-toggle"
          aria-label="Volgende treffer"
          disabled={matchCount === 0}
          on:click={() => stepMatch(1)}
        >
          <svg class="recording__icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7 10l5 5 5-5" />
          </svg>
        </button>
        <button
          type="button"
          class="recording__search-toggle"
          aria-label="Sluit zoeken"
          on:click={closeSearch}
        >
          <svg class="recording__icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M17 7L7 17" />
            <path d="M7 7l10 10" />
          </svg>
        </button>
      {:else}
        <button
          type="button"
          class="recording__search-toggle"
          aria-label="Zoek in de videotulen"
          on:click={openSearch}
        >
          <svg class="recording__icon" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="M15.5 15.5L21 21" />
          </svg>
        </button>
      {/if}
    </div>

    {#if segments.length === 0}
      <p class="recording__empty">
        Geen uitgeschreven tekst beschikbaar bij deze opname.
      </p>
    {:else}
      <div
        class="recording__segments"
        bind:this={transcriptEl}
        on:wheel={() => (followPlayhead = false)}
        role="log"
      >
        {#each chapterBlocks as block (block.key)}
          <!-- One section per chapter so the sticky heading is carried off by
               the next one instead of piling up behind it. -->
          <section class="recording__chapter">
            {#if block.chapter}
              <h4 class="recording__chapter-heading">
                <button type="button" on:click={() => seek(block.chapter.start)}>
                  <!-- The number doubles as the keyboard shortcut: typing it
                       anywhere in the meeting jumps the video here. Shown on
                       every chapter, because a shortcut nobody can see is one
                       nobody uses. -->
                  <span class="recording__chapter-key" aria-hidden="true"
                    >{block.chapter.number}</span
                  >
                  <span class="recording__time">{formatClock(block.chapter.start)}</span>
                  <span>{chapterLabel(block.chapter.title, block.chapter.number)}</span>
                </button>
              </h4>
            {/if}
            {#each block.segments as row (row.key)}
              <p
                class="recording__segment"
                class:recording__segment--active={row.index === activeIndex && !term}
                data-index={row.index}
              >
                <button
                  type="button"
                  class="recording__time recording__time--button"
                  on:click={() => seek(row.segment.start_seconds)}
                >
                  {formatClock(row.segment.start_seconds)}
                </button>
                {#if row.segment.speaker}
                  <span class="recording__speaker">{row.segment.speaker}</span>
                {/if}
                <span class="recording__text">
                  {#each splitOnMatches( row.segment.text, matches.perSegment[row.index] ?? [], term.length, matches.offsets[row.index] ?? 0, ) as part}
                    {#if part.matchIndex !== null}<mark
                        class:recording__mark--active={part.matchIndex === activeMatch}
                        data-match={part.matchIndex}
                      >{part.text}</mark>{:else}{part.text}{/if}
                  {/each}
                </span>
              </p>
            {/each}
          </section>
        {/each}
      </div>
    {/if}

  </div>
</section>
