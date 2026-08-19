import "./../styles.css";
import { mount } from "svelte";
import DocsPage from "./DocsPage.svelte";

const target = document.getElementById("docs-app");

if (!target) {
  throw new Error("Docs root #docs-app niet gevonden.");
}

/** One page serving both markdown documents, chosen by path. `/docs/api` is
 * the API reference; `/docs/migration-guide` the guide for Open
 * Raadsinformatie reusers, which until now was only served as plain text. */
const PAGES: Record<string, { source: string; title: string; lang: string }> = {
  // Both documents are written in English while the application declares
  // itself Dutch, so a Dutch speech synthesiser read English words with Dutch
  // phonetics -- correct and unintelligible at the same time (WCAG 3.1.2).
  // The language travels with the document rather than being assumed.
  "/docs/api": { source: "/API.md", title: "API", lang: "en" },
  "/docs/migration-guide": {
    source: "/docs/migration-guide.md",
    title: "Migreren van Open Raadsinformatie",
    lang: "en",
  },
};

const page = PAGES[window.location.pathname] ?? PAGES["/docs/api"];

mount(DocsPage, { target, props: page });
