// Automated WCAG 2.1 A/AA check of the public pages with axe-core.
//
// Starts web/server.ts against the built front end (`pnpm run build:web`
// first) and needs no Quickwit or S3: /api/search and /api/stats are answered
// from a fixture inside the browser, so the search page is checked with real
// result cards and with an empty result. Fails on serious or critical
// violations that are not in scripts/a11y-baseline.json.
//
//   node scripts/a11y_check.mjs
//
// A11Y_BASE_URL checks an already running server instead of starting one.
// PLAYWRIGHT_CHROMIUM_EXECUTABLE points at a Chromium of your own.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { AxeBuilder } from "@axe-core/playwright";
import { chromium } from "playwright";

const repoRoot = new URL("../", import.meta.url);
const baseline = JSON.parse(readFileSync(new URL("a11y-baseline.json", import.meta.url), "utf8"));
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const BLOCKING_IMPACTS = new Set(["serious", "critical"]);

const PAGES = [
  { name: "home", path: "/" },
  { name: "search-results", path: "/?query=begroting" },
  { name: "search-empty", path: "/?query=zzzgeenresultaat" },
  { name: "document-reader", path: "/?query=begroting&view=a11y-doc-1" },
  { name: "api-docs", path: "/docs/api" },
  { name: "migration-guide", path: "/docs/migration-guide" },
];

const SEARCH_RESULTS = {
  totalCount: 2,
  reachableCount: 2,
  hasMore: false,
  results: [
    {
      entityId: "a11y-doc-1",
      entityType: "document",
      entityTypeLabel: "Document",
      organization: "Haarlem",
      date: "2026-01-14",
      title: "Raadsvoorstel begroting 2026",
      summary: "Het college stelt voor de begroting 2026 vast te stellen.",
      summaryHtml: "Het college stelt voor de <mark>begroting</mark> 2026 vast te stellen.",
      downloadUrl: "/api/entities/a11y-doc-1/download",
      pageCount: 12,
    },
    {
      entityId: "a11y-meeting-1",
      entityType: "meeting",
      entityTypeLabel: "Vergadering",
      organization: "Haarlem",
      date: "2026-01-15",
      title: "Gemeenteraad 15 januari 2026",
      summary: "Behandeling van de begroting.",
    },
  ],
};

const DOCUMENT_DETAIL = {
  entityId: "a11y-doc-1",
  entityType: "document",
  entityTypeLabel: "Document",
  title: "Raadsvoorstel begroting 2026",
  organization: "Haarlem",
  date: "2026-01-14",
  contentType: "text/markdown",
  markdownText:
    "# Raadsvoorstel begroting 2026\n\nHet college stelt voor de **begroting** 2026 vast te stellen.\n\n" +
    "## Beslispunten\n\n1. De begroting vaststellen.\n2. De meerjarenraming voor kennisgeving aannemen.\n",
};

const STATS = {
  documentCount: 5100000,
  organizationCount: 340,
  municipalityCount: 300,
  waterBoardCount: 21,
  provinceCount: 12,
};

function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        const response = await fetch(url);
        if (response.ok) return resolve();
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) return reject(new Error(`${url} did not come up`));
      setTimeout(attempt, 500);
    };
    attempt();
  });
}

async function startServer() {
  const port = process.env.A11Y_PORT ?? "8797";
  const server = spawn("deno", ["run", "-A", "web/server.ts"], {
    cwd: repoRoot,
    env: { ...process.env, PORT: port, QUICKWIT_URL: "http://127.0.0.1:9" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(`${baseUrl}/`, 60_000);
  return { baseUrl, stop: () => server.kill() };
}

async function mockApi(page) {
  await page.route("**/api/stats", (route) => route.fulfill({ json: STATS }));
  await page.route("**/api/entities/a11y-doc-1", (route) =>
    route.fulfill({ json: DOCUMENT_DETAIL }),
  );
  await page.route("**/api/search?**", (route) => {
    const query = new URL(route.request().url()).searchParams.get("query") ?? "";
    const empty = query.includes("zzzgeenresultaat");
    route.fulfill({
      json: empty
        ? { results: [], totalCount: 0, reachableCount: 0, hasMore: false }
        : SEARCH_RESULTS,
    });
  });
}

function isBaselined(pageName, ruleId) {
  return (baseline[pageName] ?? []).includes(ruleId) || (baseline["*"] ?? []).includes(ruleId);
}

const server = process.env.A11Y_BASE_URL
  ? { baseUrl: process.env.A11Y_BASE_URL.replace(/\/$/, ""), stop: () => {} }
  : await startServer();
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
});

let failures = 0;
try {
  for (const target of PAGES) {
    const context = await browser.newContext({ locale: "nl-NL" });
    const page = await context.newPage();
    await mockApi(page);
    await page.goto(`${server.baseUrl}${target.path}`, { waitUntil: "networkidle" });
    const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    await context.close();

    const blocking = violations.filter((v) => BLOCKING_IMPACTS.has(v.impact));
    const fresh = blocking.filter((v) => !isBaselined(target.name, v.id));
    const minor = violations.length - blocking.length;
    console.log(
      `${target.name} (${target.path}): ${fresh.length} new serious/critical, ` +
        `${blocking.length - fresh.length} baselined, ${minor} minor/moderate`,
    );
    for (const v of violations) {
      const marker = !BLOCKING_IMPACTS.has(v.impact)
        ? "  info"
        : isBaselined(target.name, v.id)
          ? "  base"
          : "  FAIL";
      console.log(`${marker} [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} nodes)`);
      if (marker === "  FAIL") {
        for (const node of v.nodes.slice(0, 5)) console.log(`         ${node.target.join(" ")}`);
      }
    }
    failures += fresh.length;
  }
} finally {
  await browser.close();
  server.stop();
}

if (failures > 0) {
  console.error(`\n${failures} serious/critical accessibility violation(s).`);
  process.exit(1);
}
console.log("\nNo new serious/critical accessibility violations.");
