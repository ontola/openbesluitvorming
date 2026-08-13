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
const PAGES: Record<string, { source: string; title: string }> = {
  "/docs/api": { source: "/API.md", title: "API" },
  "/docs/migration-guide": {
    source: "/docs/migration-guide.md",
    title: "Migreren van Open Raadsinformatie",
  },
};

const page = PAGES[window.location.pathname] ?? PAGES["/docs/api"];

mount(DocsPage, { target, props: page });
