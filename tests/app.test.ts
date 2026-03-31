import { Window } from "npm:happy-dom";
import { bootstrapSearchApp } from "../web/src/app.ts";
import type { EntityContentResponse, SearchResult } from "../src/types.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

Deno.test({
  name: "search app restores open detail from URL and highlights matching text",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const html = await Deno.readTextFile(new URL("../web/index.html", import.meta.url));
    const entityId = "document:notubiz:gemeente:haarlem:15046838";
    const window = new Window({
      url: `http://127.0.0.1:4317/?query=grondprijs&organization=haarlem&view=${encodeURIComponent(entityId)}`,
    });

    window.document.write(html);
    window.document.close();

    const result: SearchResult = {
      entityId,
      entityType: "Document",
      entityTypeLabel: "Document",
      organization: "Gemeente Haarlem",
      date: "14 januari 2025",
      title: "2 Bijlage Grondprijsbrief 2025",
      summary: "Grondprijsbrief met actuele bedragen.",
      sortDate: "2025-01-14T17:00:00Z",
      downloadUrl: "https://example.test/document.pdf",
    };
    const content: EntityContentResponse = {
      entityId,
      entityType: "Document",
      markdownText: "## Grondprijsbrief 2025\n\nDe grondprijs wordt jaarlijks vastgesteld.",
      downloadUrl: "https://example.test/document.pdf",
    };

    await bootstrapSearchApp({
      document: window.document as unknown as Document,
      windowImpl: window,
      fetchImpl: async (input) => {
        const url = typeof input === "string" ? input : "url" in input ? input.url : input.href;
        if (url.includes("/api/entities/")) {
          return new Response(JSON.stringify(content), {
            headers: { "content-type": "application/json" },
          });
        }

        return new Response(JSON.stringify({ results: [result] }), {
          headers: { "content-type": "application/json" },
        });
      },
    });

    const detailOverlay = window.document.querySelector(
      "#detail-overlay",
    ) as unknown as HTMLElement | null;
    const detailText = window.document.querySelector(
      '[data-role="detail-text"]',
    ) as unknown as HTMLElement | null;
    const downloadLink = window.document.querySelector(
      '[data-role="detail-download"]',
    ) as unknown as HTMLAnchorElement | null;
    const closeButton = window.document.querySelector(
      '[data-role="close-detail"]',
    ) as unknown as HTMLElement | null;

    assert(
      detailOverlay && !detailOverlay.hidden,
      "expected detail overlay to open from URL state",
    );
    assert(
      detailText?.querySelector("h2")?.textContent?.includes("Grondprijsbrief 2025"),
      "expected markdown to render as HTML",
    );
    assert(detailText?.innerHTML.includes("<mark>Grondprijs</mark>"), "expected highlighted text");
    assert(
      downloadLink?.closest(".detail-sheet__header-actions"),
      "expected download link to be rendered in the header action row",
    );
    assert(
      new URL(window.location.href).searchParams.get("view") === entityId,
      "expected open detail to stay represented in the URL",
    );

    closeButton?.dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event,
    );
    assert(!window.location.search.includes("view="), "expected close to clear the view parameter");
  },
});

Deno.test({
  name: "search app can switch a PDF-backed document between text and PDF views",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const html = await Deno.readTextFile(new URL("../web/index.html", import.meta.url));
    const entityId = "document:notubiz:gemeente:haarlem:15046838";
    const window = new Window({
      url: `http://127.0.0.1:4317/?query=grondprijs&organization=haarlem&view=${encodeURIComponent(entityId)}`,
    });

    window.document.write(html);
    window.document.close();

    const result: SearchResult = {
      entityId,
      entityType: "Document",
      entityTypeLabel: "Document",
      organization: "Gemeente Haarlem",
      date: "14 januari 2025",
      title: "2 Bijlage Grondprijsbrief 2025",
      summary: "Grondprijsbrief met actuele bedragen.",
      sortDate: "2025-01-14T17:00:00Z",
      downloadUrl: "https://example.test/document.pdf",
    };
    const content: EntityContentResponse = {
      entityId,
      entityType: "Document",
      markdownText: "## Grondprijsbrief 2025\n\nDe grondprijs wordt jaarlijks vastgesteld.",
      downloadUrl: "https://example.test/document.pdf",
      contentType: "application/pdf",
      pdfUrl: "https://example.test/document.pdf",
    };

    await bootstrapSearchApp({
      document: window.document as unknown as Document,
      windowImpl: window,
      fetchImpl: async (input) => {
        const url = typeof input === "string" ? input : "url" in input ? input.url : input.href;
        if (url.includes("/api/entities/")) {
          return new Response(JSON.stringify(content), {
            headers: { "content-type": "application/json" },
          });
        }

        return new Response(JSON.stringify({ results: [result] }), {
          headers: { "content-type": "application/json" },
        });
      },
    });

    const viewSwitch = window.document.querySelector(
      '[data-role="detail-view-switch"]',
    ) as unknown as HTMLElement | null;
    const pdfButton = window.document.querySelector(
      '[data-role="detail-view-pdf"]',
    ) as unknown as HTMLButtonElement | null;
    const textPane = window.document.querySelector(
      '[data-role="detail-text"]',
    ) as unknown as HTMLElement | null;
    const pdfPane = window.document.querySelector(
      '[data-role="detail-pdf"]',
    ) as unknown as HTMLElement | null;
    const pdfFrame = window.document.querySelector(
      '[data-role="detail-pdf-frame"]',
    ) as unknown as HTMLIFrameElement | null;

    assert(viewSwitch && !viewSwitch.hidden, "expected PDF/text switch for a PDF-backed document");
    assert(textPane && !textPane.hidden, "expected text view to be active by default");
    assert(pdfPane && pdfPane.hidden, "expected PDF view to be hidden by default");

    pdfButton?.dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event,
    );

    assert(pdfPane && !pdfPane.hidden, "expected PDF pane to become visible after switching");
    assert(textPane && textPane.hidden, "expected text pane to hide after switching to PDF");
    assert(
      pdfFrame?.getAttribute("src") ===
        "https://example.test/document.pdf#toolbar=0&navpanes=0&view=FitH",
      "expected embedded PDF frame to use the clean viewer PDF URL",
    );
  },
});
