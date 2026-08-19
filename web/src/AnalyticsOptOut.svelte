<script lang="ts">
  import { onMount } from "svelte";
  import { analyticsOptedOut, browserSignalsNoTracking, setAnalyticsOptOut } from "./analytics.ts";

  /** Two pages carry this control now -- the short section on the home page and
   * the privacy statement it links to -- so the state lives with the button
   * rather than in whichever page happens to host it. Both values are read on
   * mount because both are answers the browser gives, not the server. */
  let optOut = false;
  let blockedBySignal = false;

  onMount(() => {
    optOut = analyticsOptedOut();
    blockedBySignal = browserSignalsNoTracking();
  });

  function toggle(): void {
    optOut = !optOut;
    setAnalyticsOptOut(optOut);
  }
</script>

<p class="analytics-optout">
  {#if blockedBySignal}
    <!-- De knop zou hier niets toevoegen: het browsersignaal houdt de meting al tegen. -->
    <span class="analytics-optout__status">
      De meting staat uit: je browser stuurt een Do Not Track- of Global Privacy
      Control-signaal.
    </span>
  {:else}
    <button type="button" class="ghost-button ghost-button--subtle" on:click={toggle}>
      {optOut ? "Meting weer aanzetten" : "Meting uitzetten"}
    </button>
    <span class="analytics-optout__status">
      {optOut
        ? "De meting staat uit in deze browser."
        : "De meting staat aan in deze browser."}
    </span>
  {/if}
</p>
