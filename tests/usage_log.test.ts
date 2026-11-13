import { assert, assertEquals } from "jsr:@std/assert";
import {
  agentClassOf,
  applySearchNotice,
  originOf,
  routeOf,
  type UsageSummary,
  UsageTracker,
} from "../web/usage_log.ts";

const SITE = {
  "sec-fetch-site": "same-origin",
  "user-agent": "Mozilla/5.0 (Macintosh) Firefox/144.0",
};
const SCRIPT = { "user-agent": "opub-harvester/2.0 (+mailto:info@example.nl)" };

function req(path: string, headers: Record<string, string>): Request {
  return new Request(`https://openbesluitvorming.nl${path}`, { headers });
}

function fakeClock(start = 1_000_000) {
  let current = start;
  return { now: () => current, advance: (ms: number) => (current += ms) };
}

Deno.test("routes are grouped and internal routes are left out", () => {
  assertEquals(routeOf("/api/search"), "search");
  assertEquals(routeOf("/api/entities/document:x/pdf/page/1"), "entities");
  assertEquals(routeOf("/api/export/changes"), "export");
  assertEquals(routeOf("/api/sources"), "other_api");
  assertEquals(routeOf("/api/admin/summary"), null);
  assertEquals(routeOf("/api/ops/health"), null);
  assertEquals(routeOf("/"), null);
});

Deno.test("the site's own fetches are told apart from scripts by Sec-Fetch-Site", () => {
  assertEquals(originOf(new Headers(SITE)), "site");
  assertEquals(originOf(new Headers({ "sec-fetch-site": "cross-site" })), "browser_other");
  assertEquals(originOf(new Headers(SCRIPT)), "script");
});

Deno.test("user agents are classed as browser, bot or script", () => {
  assertEquals(agentClassOf(SITE["user-agent"]), "browser");
  assertEquals(agentClassOf("Mozilla/5.0 (compatible; Googlebot/2.1)"), "bot");
  assertEquals(agentClassOf("Mozilla/5.0 HeadlessChrome/120"), "bot");
  assertEquals(agentClassOf("python-requests/2.32"), "script");
  assertEquals(agentClassOf(""), "script");
});

Deno.test("one summary per window, with search split by origin and the busiest clients", () => {
  const clock = fakeClock();
  const out: UsageSummary[] = [];
  const tracker = new UsageTracker((s) => out.push(s), clock.now, 600_000);

  tracker.record(req("/api/search?query=a&limit=24", SITE), "1.1.1.1", 200);
  for (let i = 0; i < 5; i++) {
    tracker.record(
      req(`/api/search?query=x&offset=${i * 100}`, SCRIPT),
      "2.2.2.2",
      i < 4 ? 200 : 429,
    );
  }
  tracker.record(req("/api/entities/document:x", SCRIPT), "2.2.2.2", 200);
  tracker.record(req("/assets/main.js", SITE), "1.1.1.1", 200);
  assertEquals(out.length, 0, "nothing until the window ends");

  clock.advance(600_000);
  tracker.rollIfDue();
  assertEquals(out.length, 1);
  const summary = out[0];
  assertEquals(summary.event, "api_usage");
  assertEquals(summary.requests, 7, "static files are not counted");
  assertEquals(summary.limited, 1);
  assertEquals(summary.by_route.search, 6);
  assertEquals(summary.search_by_origin, { site: 1, browser_other: 0, script: 5 });
  assertEquals(summary.clients, 2);
  const top = summary.top_clients[0];
  assertEquals(top.client, "2.2.2.2");
  assertEquals(
    top.agent,
    SCRIPT["user-agent"],
    "a script's user agent is kept: it names who to contact",
  );
  assertEquals(top.routes.search, 5);
  assertEquals(top.limited, 1);
  assertEquals(summary.top_clients[1].agent, "browser", "a browser's user agent is not");
  assertEquals(summary.top_clients[1].client, "-", "nor a browser's address");
  assert(!JSON.stringify(summary).includes("query="), "query text is never logged");

  clock.advance(600_000);
  tracker.rollIfDue();
  assertEquals(out.length, 1, "an empty window logs nothing");
});

Deno.test("search calls from scripts are pointed at the export API, the site's are not", () => {
  const fromScript = new Response("{}");
  applySearchNotice(req("/api/search?query=x", SCRIPT), fromScript);
  assert(fromScript.headers.get("link")?.includes("bulk-export"));
  assert(fromScript.headers.get("x-openbesluitvorming-notice")?.includes("/api/export"));

  const fromSite = new Response("{}");
  applySearchNotice(req("/api/search?query=x", SITE), fromSite);
  assertEquals(fromSite.headers.get("x-openbesluitvorming-notice"), null);

  const otherRoute = new Response("{}");
  applySearchNotice(req("/api/entities/x", SCRIPT), otherRoute);
  assertEquals(otherRoute.headers.get("x-openbesluitvorming-notice"), null);
});
