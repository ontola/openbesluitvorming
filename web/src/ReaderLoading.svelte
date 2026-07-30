<script lang="ts">
  /**
   * Loading state for the detail reader: a spoken label plus placeholder shapes.
   *
   * The shapes alone were ambiguous — a meeting mid-load read as "Geen agenda
   * beschikbaar" and a document as a page that had finished rendering oddly —
   * so the label is the point and the shapes only hint at what is coming.
   */
  export let label: string;
  export let variant: "text" | "agenda" | "pages" = "text";
  export let lines = 6;
</script>

<div class="reader-loading" role="status">
  <p class="reader-loading__label">
    <span class="reader-loading__spinner" aria-hidden="true"></span>
    {label}
  </p>

  <div class="reader-loading__shapes" aria-hidden="true">
    {#if variant === "text"}
      {#each Array.from({ length: lines }) as _, index}
        <span class="skeleton reader-loading__line" style={`animation-delay:${index * 80}ms`}></span>
      {/each}
    {:else if variant === "agenda"}
      {#each Array.from({ length: 3 }) as _, index}
        <span class="skeleton reader-loading__card" style={`animation-delay:${index * 120}ms`}></span>
      {/each}
    {:else}
      {#each Array.from({ length: 2 }) as _, index}
        <span class="skeleton reader-loading__page" style={`animation-delay:${index * 120}ms`}></span>
      {/each}
    {/if}
  </div>
</div>
