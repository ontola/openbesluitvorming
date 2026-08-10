<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import type { MeetingMotion } from "../../src/types.ts";

  const dispatch = createEventDispatcher<{ open: { entityId: string } }>();

  export let motion: MeetingMotion;
  /** "card" sits among agenda items, where a frame separates it from the
   * surrounding content. "row" is for a motion's own page: the sheet is
   * already a surface, so another bordered box reads as a card in a card. */
  export let variant: "card" | "row" = "card";

  /** Group the per-member votes by fractie.
   *
   * Council members vote by party in the overwhelming majority of cases, but
   * not always — a split fractie is exactly the kind of thing a reader is
   * looking for, so keep both counts per group rather than collapsing to a
   * single verdict. */
  function byParty(votes: MeetingMotion["votes"]) {
    const groups = new Map<string, { name: string; voor: number; tegen: number }>();
    for (const vote of votes ?? []) {
      const name = vote.group_name ?? "Onbekende fractie";
      const group = groups.get(name) ?? { name, voor: 0, tegen: 0 };
      if (vote.option === "voor") {
        group.voor += 1;
      } else {
        group.tegen += 1;
      }
      groups.set(name, group);
    }
    return [...groups.values()].sort((a, b) =>
      b.voor + b.tegen - (a.voor + a.tegen) || a.name.localeCompare(b.name, "nl")
    );
  }

  let showVotes = false;

  $: parties = byParty(motion.votes);
  $: resultLabel = motion.result ? motion.result[0].toUpperCase() + motion.result.slice(1) : null;
  $: hasMeta = Boolean(motion.motion_type) || Boolean(motion.parties?.length);
</script>

<article class="motion motion--{variant}">
  {#if variant === "card"}
    <!-- Same pill as the documents above it: a motion is another thing you
         open, read and download, so it should not look like a different
         species of row. -->
    <div class="entity-pill">
      <button
        type="button"
        class="entity-pill__main"
        on:click={() => dispatch("open", { entityId: motion.id })}
      >
        <span class="entity-pill__icon" aria-hidden="true">🗳</span>
        <span class="entity-pill__label entity-pill__label--wrap">{motion.name}</span>
        {#if resultLabel}
          <span class="motion__result motion__result--{motion.result}" title={motion.status}>
            {resultLabel}
          </span>
        {/if}
        {#if motion.attachment_id && motion.attachment_is_pdf}
          <div class="entity-pill__thumb" aria-hidden="true">
            <img
              src={`/api/entities/${encodeURIComponent(motion.attachment_id)}/pdf/page/1`}
              alt=""
              loading="lazy"
            />
          </div>
        {/if}
      </button>

      <div class="entity-pill__actions">
        {#if parties.length > 0}
          <button
            type="button"
            class="entity-pill__action"
            aria-expanded={showVotes}
            aria-label={`${showVotes ? "Verberg" : "Toon"} stemmen per fractie voor ${motion.name}`}
            on:click|stopPropagation={() => (showVotes = !showVotes)}
          >
            <span aria-hidden="true">{showVotes ? "−" : "≣"}</span>
            <span>{showVotes ? "Sluit" : "Stemmen"}</span>
          </button>
        {/if}
        {#if motion.download_url}
          <a
            class="entity-pill__action"
            href={motion.download_url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Download ${motion.name}`}
            on:click|stopPropagation
          >
            <span aria-hidden="true">↓</span>
            <span>Download</span>
          </a>
        {/if}
      </div>
    </div>
  {/if}

  {#if hasMeta || (resultLabel && variant === "row")}
    <header class="motion__header">
      <!-- In a pill the chip sits beside the title; on the motion's own page
           there is no pill, so it leads the row instead. -->
      {#if resultLabel && variant === "row"}
        <span class="motion__result motion__result--{motion.result}" title={motion.status}>
          {resultLabel}
        </span>
      {/if}
      {#if hasMeta}
        <p class="motion__meta">
          {#if motion.motion_type}<span>{motion.motion_type}</span>{/if}
          {#if motion.parties?.length}<span>{motion.parties.join(", ")}</span>{/if}
        </p>
      {/if}
    </header>
  {/if}

  {#if motion.tally}
    <p class="motion__tally">
      <strong>{motion.tally.in_favour}</strong> voor ·
      <strong>{motion.tally.against}</strong> tegen
      <!-- The card has this as a button in its action stack; here there is no
           stack to put it in. -->
      {#if variant === "row"}
        <button
          type="button"
          class="motion__toggle"
          aria-expanded={showVotes}
          on:click={() => (showVotes = !showVotes)}
        >
          {showVotes ? "Verberg stemmen" : "Toon stemmen per fractie"}
        </button>
      {/if}
    </p>
  {/if}

  {#if showVotes && parties.length > 0}
    <ul class="motion__parties">
      {#each parties as party}
        <li class="motion__party">
          <span class="motion__party-name">{party.name}</span>
          <span class="motion__party-votes">
            {#if party.voor > 0}<span class="motion__voor">{party.voor} voor</span>{/if}
            {#if party.voor > 0 && party.tegen > 0}<span aria-hidden="true"> · </span>{/if}
            {#if party.tegen > 0}<span class="motion__tegen">{party.tegen} tegen</span>{/if}
          </span>
        </li>
      {/each}
    </ul>
  {/if}

  <!-- Some municipalities publish the breakdown only as a sentence. Shown as
       written rather than parsed into counts. -->
  {#if motion.vote_summary}
    <p class="motion__summary">{motion.vote_summary}</p>
  {/if}

  {#if motion.proposers?.length}
    <p class="motion__proposers">
      <span class="motion__proposers-label">Indiener(s):</span>
      {motion.proposers.join("; ")}
      {#if motion.co_proposers?.length}
        <span class="motion__proposers-label">Mede-indieners:</span>
        {motion.co_proposers.join("; ")}
      {/if}
    </p>
  {/if}

  {#if !motion.tally && !motion.vote_summary && motion.agenda_item_hint}
    <p class="motion__hint">{motion.agenda_item_hint}</p>
  {/if}
</article>

<style>
  .motion {
    display: grid;
    gap: 0.5rem;
  }

  /* The pill draws the frame, so the card itself only spaces things out. The
     inline padding lines the details up with the title inside the pill. */
  .motion--card {
    gap: 0.35rem;
  }

  .motion--card .motion__header,
  .motion--card .motion__tally,
  .motion--card .motion__parties,
  .motion--card .motion__summary,
  .motion--card .motion__proposers,
  .motion--card .motion__hint {
    padding-inline: 0.9rem;
  }

  .motion--card .motion__tally {
    margin-top: 0.1rem;
  }

  /* Pushed to the far end of the title row, and the thumbnail then follows it
     directly rather than splitting the free space with it. */
  .motion--card .motion__result {
    margin-left: auto;
  }

  .motion--card .motion__result + .entity-pill__thumb {
    margin-left: 0.55rem;
  }

  /* One quiet line on a motion's own page. `display: contents` lets the chip,
     the tally and the meta share a row without duplicating the markup, and a
     single rule below the whole thing replaces the frame. */
  .motion--row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    column-gap: 0.75rem;
    row-gap: 0.4rem;
    padding-bottom: 0.9rem;
    border-bottom: 1px solid var(--line);
  }

  .motion--row .motion__header {
    display: contents;
  }

  .motion--row .motion__result {
    order: -1;
  }

  .motion--row .motion__parties,
  .motion--row .motion__summary,
  .motion--row .motion__proposers,
  .motion--row .motion__hint {
    flex-basis: 100%;
  }

  /* The per-fractie list carries its own rules in a card; on a page that
     already reads as one block, spacing separates them well enough. */
  .motion--row .motion__party {
    border-bottom: 0;
    padding: 0.1rem 0;
  }

  .motion--row .motion__parties {
    margin-top: 0.15rem;
    gap: 0.05rem;
  }

  .motion__header {
    display: flex;
    gap: 0.75rem;
    align-items: baseline;
  }

  .motion__meta {
    margin: 0;
    color: var(--muted);
    font-size: 0.85rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .motion__result {
    flex: none;
    padding: 0.15rem 0.55rem;
    border-radius: 999px;
    font-size: 0.8rem;
    font-weight: 700;
    white-space: nowrap;
    /* Neutral default; the outcome-specific rules below tint it. Colour is
       never the only signal — the word itself is in the chip. */
    background: rgba(95, 111, 134, 0.15);
    color: var(--muted);
  }

  .motion__result--aangenomen {
    background: rgba(38, 138, 90, 0.16);
    color: #1c7a4d;
  }

  .motion__result--verworpen {
    background: rgba(190, 62, 62, 0.16);
    color: #a63232;
  }

  .motion__tally {
    margin: 0;
    font-size: 0.9rem;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.6rem;
  }

  .motion__toggle {
    border: 0;
    background: none;
    padding: 0;
    color: var(--accent-deep);
    font: inherit;
    font-size: 0.85rem;
    cursor: pointer;
    text-decoration: underline;
  }

  .motion__parties {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 0.2rem;
  }

  .motion__party {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    font-size: 0.87rem;
    padding: 0.15rem 0;
    border-bottom: 1px solid var(--line);
  }

  .motion__party-name {
    font-weight: 600;
  }

  .motion__voor {
    color: #1c7a4d;
  }

  .motion__tegen {
    color: #a63232;
  }

  .motion__summary {
    margin: 0;
    font-size: 0.87rem;
    line-height: 1.5;
    white-space: pre-line;
    color: var(--text);
  }

  .motion__proposers,
  .motion__hint {
    margin: 0;
    font-size: 0.85rem;
    color: var(--muted);
    line-height: 1.5;
  }

  .motion__proposers-label {
    font-weight: 600;
  }

  @media (prefers-color-scheme: dark) {
    .motion__result--aangenomen {
      background: rgba(64, 190, 130, 0.18);
      color: #6edea8;
    }

    .motion__result--verworpen {
      background: rgba(240, 110, 110, 0.18);
      color: #ff9c9c;
    }

    .motion__voor {
      color: #6edea8;
    }

    .motion__tegen {
      color: #ff9c9c;
    }
  }
</style>
