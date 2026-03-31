<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import type { AdminSourceOption } from "../../src/types.ts";

  export let options: AdminSourceOption[] = [];
  export let value = "";
  export let placeholder = "Alle organisaties";
  export let valueSelector: (source: AdminSourceOption) => string = (source) => source.key;
  export let subtitle: (source: AdminSourceOption) => string = (source) =>
    `${source.supplier} · ${source.organizationType}`;
  export let emptyMessage = "Geen bronnen gevonden.";

  const dispatch = createEventDispatcher<{
    change: { value: string; source: AdminSourceOption | null };
  }>();

  let query = "";
  let open = false;

  $: selected = options.find((source) => valueSelector(source) === value) ?? null;
  $: if (selected && query !== selected.label) {
    query = selected.label;
  }
  $: filtered = query.trim()
    ? options.filter((source) =>
        [source.label, source.key, source.sourceRef, source.supplier, source.organizationType]
          .join(" ")
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      )
    : [];

  function choose(source: AdminSourceOption | null): void {
    value = source ? valueSelector(source) : "";
    query = source?.label ?? "";
    open = false;
    dispatch("change", { value, source });
  }

  function onInput(event: Event): void {
    query = (event.currentTarget as HTMLInputElement).value;
    if (!query.trim()) {
      choose(null);
      return;
    }

    const exact = options.find((source) => source.label === query) ?? null;
    if (exact) {
      value = valueSelector(exact);
      dispatch("change", { value, source: exact });
      open = false;
      return;
    }

    value = "";
    dispatch("change", { value: "", source: null });
    open = true;
  }
</script>

<div class:source-picker--open={open} class="source-picker search-panel__source-picker">
  <label class="search-field search-field--subtle search-field--compact">
    <span class="sr-only">Bestuurslaag of organisatie</span>
    <input
      type="search"
      autocomplete="off"
      {placeholder}
      bind:value={query}
      on:focus={() => {
        if (query.trim()) open = true;
      }}
      on:input={onInput}
      on:blur={() => {
        window.setTimeout(() => {
          open = false;
          if (!value) {
            query = "";
          }
        }, 120);
      }}
    />
  </label>

  {#if open}
    <div class="source-picker__results">
      {#if filtered.length === 0}
        <div class="source-picker__empty">{emptyMessage}</div>
      {:else}
        {#each filtered as source}
          <button
            type="button"
            class="source-picker__option"
            disabled={!source.implemented}
            on:click={() => {
              if (!source.implemented) return;
              choose(source);
            }}
          >
            <strong>{source.label}</strong>
            <span>{subtitle(source)}</span>
          </button>
        {/each}
      {/if}
    </div>
  {/if}
</div>
