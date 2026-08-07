<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import type { MeetingRecording } from "../../src/types.ts";

  export let recording: MeetingRecording;

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

  /** Bound by the parent so the agenda can drive the player: the agenda item
   * is where a reader decides to jump, and it lives outside this component. */
  export function seek(seconds: number): void {
    if (!videoEl) {
      return;
    }
    followPlayhead = true;
    videoEl.currentTime = seconds;
    void videoEl.play();
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

  /** Split on the query so a match can be wrapped in a <mark> without ever
   * putting supplier text through {@html}.
   *
   * `offset` is the running match count of the segments before this one, so
   * every occurrence in the transcript gets a stable number and the find bar
   * can point at exactly one of them. */
  function highlight(
    text: string,
    term: string,
    offset = 0,
  ): Array<{ text: string; matchIndex: number | null }> {
    if (!term) {
      return [{ text, matchIndex: null }];
    }
    const parts: Array<{ text: string; matchIndex: number | null }> = [];
    const haystack = text.toLowerCase();
    const needle = term.toLowerCase();
    let index = 0;
    let seen = 0;
    while (index < text.length) {
      const found = haystack.indexOf(needle, index);
      if (found === -1) {
        parts.push({ text: text.slice(index), matchIndex: null });
        break;
      }
      if (found > index) {
        parts.push({ text: text.slice(index, found), matchIndex: null });
      }
      parts.push({ text: text.slice(found, found + needle.length), matchIndex: offset + seen });
      seen += 1;
      index = found + needle.length;
    }
    return parts;
  }

  function countOccurrences(text: string, term: string): number {
    if (!term) {
      return 0;
    }
    const haystack = text.toLowerCase();
    const needle = term.toLowerCase();
    let count = 0;
    let index = haystack.indexOf(needle);
    while (index !== -1) {
      count += 1;
      index = haystack.indexOf(needle, index + needle.length);
    }
    return count;
  }

  function stepMatch(delta: number): void {
    if (matchCount === 0) {
      return;
    }
    // Wrapping is what a find bar does, and the alternative — stopping at the
    // last hit — leaves the reader guessing whether they reached the end or
    // the button broke.
    activeMatch = (activeMatch + delta + matchCount) % matchCount;
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

  /** The transcript is the timeline, so the agenda items are folded into it as
   * headings in play order. That is deliberately not the agenda's own order:
   * the two differ in about a quarter of meetings, and here the video decides.
   * The agenda tree keeps document order and carries the same timestamps. */
  function withChapterHeadings(
    list: typeof segments,
    chapters: MeetingRecording["chapters"],
  ): Array<
    | { kind: "chapter"; key: string; title: string; start: number }
    | { kind: "segment"; key: string; index: number; segment: (typeof list)[number] }
  > {
    const rows: Array<
      | { kind: "chapter"; key: string; title: string; start: number }
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
        });
        next += 1;
      }
      rows.push({ kind: "segment", key: `s${segment.start_seconds}`, index, segment });
    });

    return rows;
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
  /** Running match count before each segment, so every occurrence has a number. */
  $: matchOffsets = segments.reduce<number[]>((acc, segment, index) => {
    acc[index] = index === 0 ? 0 : acc[index - 1] + countOccurrences(segments[index - 1].text, term);
    return acc;
  }, []);
  $: matchCount = segments.reduce((total, segment) => total + countOccurrences(segment.text, term), 0);
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
          aria-label="Zoek in het gesproken woord"
          placeholder="Zoek in het gesproken woord…"
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
          aria-label="Zoek in het gesproken woord"
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
        {#each rows as row (row.key)}
          {#if row.kind === "chapter"}
            <h4 class="recording__chapter-heading">
              <button type="button" on:click={() => seek(row.start)}>
                <span class="recording__time">{formatClock(row.start)}</span>
                <span>{row.title}</span>
              </button>
            </h4>
          {:else}
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
                {#each highlight(row.segment.text, term, matchOffsets[row.index]) as part}
                  {#if part.matchIndex !== null}<mark
                      class:recording__mark--active={part.matchIndex === activeMatch}
                      data-match={part.matchIndex}
                    >{part.text}</mark>{:else}{part.text}{/if}
                {/each}
              </span>
            </p>
          {/if}
        {/each}
      </div>
    {/if}

  </div>
</section>
