<script lang="ts">
  import type { MeetingMotion } from "../../src/types.ts";

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
</script>

<article class="motion motion--{variant}">
  <header class="motion__header">
    <div class="motion__title-group">
      <!-- On its own page the sheet heading already carries the title; a
           second copy of it here is noise. -->
      {#if variant === "card"}
        <h4 class="motion__title">{motion.name}</h4>
      {/if}
      <p class="motion__meta">
        {#if motion.motion_type}<span>{motion.motion_type}</span>{/if}
        {#if motion.parties?.length}<span>{motion.parties.join(", ")}</span>{/if}
      </p>
    </div>
    {#if resultLabel}
      <span class="motion__result motion__result--{motion.result}" title={motion.status}>
        {resultLabel}
      </span>
    {/if}
  </header>

  {#if motion.tally}
    <p class="motion__tally">
      <strong>{motion.tally.in_favour}</strong> voor ·
      <strong>{motion.tally.against}</strong> tegen
      <button
        type="button"
        class="motion__toggle"
        aria-expanded={showVotes}
        on:click={() => (showVotes = !showVotes)}
      >
        {showVotes ? "Verberg stemmen" : "Toon stemmen per fractie"}
      </button>
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

  /* Framed, because it sits among agenda items and needs separating from them. */
  .motion--card {
    padding: 0.75rem 0.9rem;
    border: 1px solid var(--line);
    border-radius: 0.7rem;
    background: var(--document-surface-muted);
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

  .motion--row .motion__meta {
    margin: 0;
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
    align-items: flex-start;
    justify-content: space-between;
  }

  .motion__title {
    margin: 0;
    font-size: 0.97rem;
    line-height: 1.35;
  }

  .motion__meta {
    margin: 0.15rem 0 0;
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
