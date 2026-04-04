<script lang="ts">
  import { marked } from "marked";
  import { createEventDispatcher } from "svelte";
  import type { EntityContentResponse, MeetingAgendaItem } from "../../src/types.ts";

  export let items: MeetingAgendaItem[] = [];

  const dispatch = createEventDispatcher<{ opendocument: { entityId: string } }>();
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
        <article class="meeting-agenda__card">
          <header class="meeting-agenda__header">
            {#if item.number}
              <span class="meeting-agenda__number">{item.number}</span>
            {/if}
            <div class="meeting-agenda__title-group">
              <h3 class="meeting-agenda__title">{item.title ?? "Agendapunt"}</h3>
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
                  <div class="meeting-agenda__document-pill">
                    <button
                      type="button"
                      class="meeting-agenda__document-main"
                      on:click={() => {
                        dispatch("opendocument", { entityId: document.id });
                      }}
                    >
                      <span class="meeting-agenda__document-pill-icon" aria-hidden="true">📄</span>
                      <span class="meeting-agenda__document-pill-label">{document.name}</span>
                      {#if isPdfDocument(document)}
                        <div class="meeting-agenda__document-thumb" aria-hidden="true">
                          <img
                            src={`/api/entities/${encodeURIComponent(document.id)}/pdf/page/1`}
                            alt=""
                            loading="lazy"
                          />
                        </div>
                      {/if}
                    </button>

                    <div class="meeting-agenda__document-actions">
                      <button
                        type="button"
                        class="meeting-agenda__document-toggle"
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
                        class="meeting-agenda__document-download"
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
                        <div class="meeting-agenda__document-skeleton" aria-hidden="true">
                          <span></span>
                          <span></span>
                          <span></span>
                          <span></span>
                          <span></span>
                        </div>
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

          {#if item.agenda_items?.length}
            <div class="meeting-agenda__children">
              <svelte:self
                items={item.agenda_items}
                on:opendocument={(event) => dispatch("opendocument", event.detail)}
              />
            </div>
          {/if}
        </article>
      </li>
    {/each}
  </ol>
{/if}
