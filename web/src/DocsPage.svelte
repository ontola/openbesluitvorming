<script lang="ts">
  import { onMount } from "svelte";
  import AnalyticsOptOut from "./AnalyticsOptOut.svelte";
  import { withHeadingAnchors } from "./doc_anchors.ts";
  import { renderOwnMarkdown } from "./markdown.ts";

  export let source: string;
  export let title: string;
  /** The language the markdown itself is written in. */
  export let lang = "nl";
  /** The privacy statement ends on the objection it describes. Markdown cannot
   * carry a button, so the page appends one when the document asks for it. */
  export let optOut = false;

  let html = "";
  let failed = false;

  onMount(async () => {
    try {
      const response = await fetch(source);
      if (!response.ok) {
        throw new Error(`${source} gaf ${response.status}`);
      }
      html = withHeadingAnchors(renderOwnMarkdown(await response.text()));
      // A link shared with a #section lands before the document exists, so the
      // browser has nothing to scroll to. Repeat the jump once it is there.
      if (window.location.hash) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        document.getElementById(decodeURIComponent(window.location.hash.slice(1)))
          ?.scrollIntoView();
      }
    } catch (error) {
      console.error("Kon documentatie niet laden", error);
      failed = true;
    }
  });
</script>

<svelte:head>
  <title>{title} — OpenBesluitvorming</title>
</svelte:head>

<header class="docs-page__header">
  <a class="docs-page__home" href="/">← OpenBesluitvorming</a>
  <a class="docs-page__source" href={source}>Bron ({source})</a>
</header>

<main class="docs-page">
  {#if failed}
    <p>
      De documentatie kon niet worden geladen. Je kunt het
      <a href={source}>bronbestand</a> rechtstreeks openen.
    </p>
  {:else if html}
    <article class="prose-detail" {lang}>
      <!-- eslint-disable-next-line svelte/no-at-html-tags -->
      {@html html}
      {#if optOut}
        <AnalyticsOptOut />
      {/if}
    </article>
  {:else}
    <p>Laden…</p>
  {/if}
</main>

<style>
  .docs-page__header {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    justify-content: space-between;
    align-items: baseline;
    max-width: 58rem;
    margin: 0 auto;
    padding: 1.25rem 1.5rem 0;
  }

  .docs-page__home {
    font-weight: 700;
  }

  .docs-page__source {
    color: var(--muted);
    font-size: 0.85rem;
  }

  /* A measure, not a full-width wall of text: this is a document to read.
     Wide enough for the field tables to breathe. */
  .docs-page {
    max-width: 58rem;
    margin: 0 auto;
    padding: 1.5rem 1.5rem 6rem;
  }

  /* Wrap rather than scroll. These blocks are curl commands meant to be read
     and copied, and a command whose tail is off the right edge reads as if it
     ends there. */
  .docs-page :global(pre) {
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* Anchored headings land under the top of the window rather than flush
     against it, so the heading you jumped to has some air above it. */
  .docs-page :global(h1),
  .docs-page :global(h2),
  .docs-page :global(h3),
  .docs-page :global(h4) {
    scroll-margin-top: 1.5rem;
  }
</style>
