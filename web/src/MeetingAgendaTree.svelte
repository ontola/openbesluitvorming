<script lang="ts">
  import { marked } from "marked";
  import { createEventDispatcher } from "svelte";
  import type { EntityContentResponse, MeetingAgendaItem, MeetingMotion } from "../../src/types.ts";
  import ReaderLoading from "./ReaderLoading.svelte";
  import MotionCard from "./MotionCard.svelte";

  export let items: MeetingAgendaItem[] = [];
  /** Motions decided in this meeting, keyed by agenda item id. Passed whole
   * through the recursion so nested items get theirs too. */
  export let motionsByAgendaItem: Record<string, MeetingMotion[]> = {};
  /** Where each agenda item starts in the recording, in seconds, keyed by
   * agenda item id. Only items that were actually on camera appear here — the
   * recording drops zero-length offsets — so a missing entry means "no video
   * for this point", not "unknown". */
  export let playheadByAgendaItem: Record<string, number> = {};

  const dispatch = createEventDispatcher<{
    opendocument: { entityId: string };
    documentpreview: { entityId: string };
    seek: { seconds: number };
  }>();

  function formatClock(seconds: number): string {
    const total = Math.max(0, Math.round(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const pad = (value: number) => String(value).padStart(2, "0");
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
  }
  let expandedDocumentId: string | null = null;
  let loadingDocumentId: string | null = null;
  let documentMarkdown: Record<string, string | null> = {};
  let documentErrors: Record<string, string | null> = {};

  function sanitizeMarkdownSource(markdown: string): string {
    return markdown.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  }

  function isPdfDocument(document: { content_type?: string; file_name?: string; original_url?: string }): boolean {
    if (document.content_type?.toLowerCase().includes("application/pdf")) return true;
    if (document.file_name?.toLowerCase().endsWith(".pdf")) return true;
    if (document.original_url?.toLowerCase().includes(".pdf")) return true;
    return false;
  }

  function renderMarkdown(markdown?: string | null): string {
    if (!markdown?.trim()) {
      return "<p>Geen documenttekst beschikbaar.</p>";
    }

    return marked.parse(sanitizeMarkdownSource(markdown), {
      async: false,
      breaks: true,
      gfm: true,
    }) as string;
  }

  async function toggleDocumentText(entityId: string): Promise<void> {
    if (expandedDocumentId === entityId) {
      expandedDocumentId = null;
      return;
    }

    expandedDocumentId = entityId;

    if (documentMarkdown[entityId] !== undefined || loadingDocumentId === entityId) {
      return;
    }

    loadingDocumentId = entityId;
    documentErrors = {
      ...documentErrors,
      [entityId]: null,
    };

    try {
      const response = await fetch(`/api/entities/${encodeURIComponent(entityId)}`);
      if (!response.ok) {
        throw new Error("Documenttekst kon niet worden geladen.");
      }

      const body = await response.text();
      if (!body) {
        throw new Error("Lege API-respons ontvangen.");
      }
      const payload = JSON.parse(body) as EntityContentResponse;
      documentMarkdown = {
        ...documentMarkdown,
        [entityId]: payload.markdownText?.trim() ? payload.markdownText : null,
      };
      // Text that arrives after the agenda rendered still has to pick up the
      // query highlight, so tell the reader to re-mark.
      dispatch("documentpreview", { entityId });
    } catch (error) {
      documentErrors = {
        ...documentErrors,
        [entityId]: error instanceof Error
          ? error.message
          : "Documenttekst kon niet worden geladen.",
      };
    } finally {
      if (loadingDocumentId === entityId) {
        loadingDocumentId = null;
      }
    }
  }
</script>

{#if items.length > 0}
  <ol class="meeting-agenda">
    {#each items as item}
      <li class="meeting-agenda__item">
        <article class="surface-card meeting-agenda__card">
          <header class="meeting-agenda__header">
            {#if item.number}
              <span class="meeting-agenda__number">{item.number}</span>
            {/if}
            <div class="meeting-agenda__title-group">
              <h3 class="meeting-agenda__title">{item.title ?? "Agendapunt"}</h3>
              {#if playheadByAgendaItem[item.id] !== undefined}
                <button
                  type="button"
                  class="meeting-agenda__play"
                  aria-label={`Speel de video af vanaf ${item.title ?? "dit agendapunt"}`}
                  on:click={() => dispatch("seek", { seconds: playheadByAgendaItem[item.id] })}
                >
                  <span aria-hidden="true">▶</span>
                  <span>{formatClock(playheadByAgendaItem[item.id])}</span>
                </button>
              {/if}
              {#if item.start_date}
                <p class="meeting-agenda__time">
                  {new Intl.DateTimeFormat("nl-NL", {
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  }).format(new Date(item.start_date))}
                </p>
              {/if}
            </div>
          </header>

          {#if item.description}
            <div class="meeting-agenda__description">{@html item.description}</div>
          {/if}

          {#if item.documents?.length}
            <div class="meeting-agenda__documents">
              {#each item.documents as document}
                <div class="meeting-agenda__document-row">
                  <div class="entity-pill">
                    <button
                      type="button"
                      class="entity-pill__main"
                      on:click={() => {
                        dispatch("opendocument", { entityId: document.id });
                      }}
                    >
                      <span class="entity-pill__icon" aria-hidden="true">📄</span>
                      <span class="entity-pill__label">{document.name}</span>
                      {#if isPdfDocument(document)}
                        <div class="entity-pill__thumb" aria-hidden="true">
                          <img
                            src={`/api/entities/${encodeURIComponent(document.id)}/pdf/page/1`}
                            alt=""
                            loading="lazy"
                          />
                        </div>
                      {/if}
                    </button>

                    <div class="entity-pill__actions">
                      <button
                        type="button"
                        class="entity-pill__action"
                        aria-expanded={expandedDocumentId === document.id}
                        aria-label={`${expandedDocumentId === document.id ? "Verberg" : "Toon"} tekst van ${document.name}`}
                        on:click|stopPropagation={() => {
                          void toggleDocumentText(document.id);
                        }}
                      >
                        <span aria-hidden="true">{expandedDocumentId === document.id ? "−" : "≣"}</span>
                        <span>{expandedDocumentId === document.id ? "Sluit" : "Tekst"}</span>
                      </button>
                      <a
                        class="entity-pill__action"
                        href={document.original_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Download ${document.name}`}
                        on:click|stopPropagation
                      >
                        <span aria-hidden="true">↓</span>
                        <span>Download</span>
                      </a>
                    </div>
                  </div>

                  {#if expandedDocumentId === document.id}
                    <div class="meeting-agenda__document-preview">
                      {#if loadingDocumentId === document.id}
                        <ReaderLoading label="Documenttekst wordt geladen…" lines={4} />
                      {:else if documentErrors[document.id]}
                        <p class="meeting-agenda__document-preview-state">{documentErrors[document.id]}</p>
                      {:else if documentMarkdown[document.id]}
                        <div class="meeting-agenda__document-markdown prose-detail">
                          {@html renderMarkdown(documentMarkdown[document.id])}
                        </div>
                      {:else}
                        <p class="meeting-agenda__document-preview-state">Geen documenttekst beschikbaar.</p>
                      {/if}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}

          {#if motionsByAgendaItem[item.id]?.length}
            <div class="meeting-agenda__motions">
              <p class="meeting-agenda__motions-label">
                Moties en amendementen bij dit agendapunt
              </p>
              {#each motionsByAgendaItem[item.id] as motion (motion.id)}
                <MotionCard
                  {motion}
                  on:open={(event) => dispatch("opendocument", event.detail)}
                />
              {/each}
            </div>
          {/if}

          {#if item.agenda_items?.length}
            <div class="meeting-agenda__children">
              <svelte:self
                items={item.agenda_items}
                {motionsByAgendaItem}
                {playheadByAgendaItem}
                on:opendocument={(event) => dispatch("opendocument", event.detail)}
                on:documentpreview={(event) => dispatch("documentpreview", event.detail)}
                on:seek={(event) => dispatch("seek", event.detail)}
              />
            </div>
          {/if}
        </article>
      </li>
    {/each}
  </ol>
{/if}
