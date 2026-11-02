/**
 * Who uses the API, in one log line per window instead of one per request.
 *
 * The request spans in SigNoz carry only the path: no query string, user
 * agent or client address. So in November 2026 we could count 1.1 million
 * /api/search calls in two weeks, but not say how many came from the site's
 * own search box, nor which clients were harvesting through search instead of
 * the export API. A log line per request would answer that at ~200,000 lines
 * a day; this aggregates per window and logs the totals plus the busiest
 * clients, which is a few hundred lines a day.
 *
 * Origin comes from `Sec-Fetch-Site`, which browsers set on every fetch and
 * scripts do not: `same-origin` is the site itself. The user agent is kept
 * verbatim only for the busiest clients, because that is where reusers put a
 * contact address and it is how we can reach them. Query text is never logged.
 */

export type UsageRoute = "search" | "entities" | "export" | "other_api";
export type UsageOrigin = "site" | "browser_other" | "script";
export type AgentClass = "browser" | "bot" | "script";

export const USAGE_WINDOW_MS = 10 * 60_000;
export const USAGE_TOP_CLIENTS = 15;
const MAX_TRACKED_CLIENTS = 5_000;
const MAX_AGENT_LENGTH = 200;

const BOT_PATTERN =
  /bot\b|bot\/|crawler|spider|slurp|headless|lighthouse|preview|facebookexternalhit|embedly|monitor|uptime/i;
const SCRIPT_PATTERN =
  /^(python|curl|wget|node|axios|go-http|java|okhttp|guzzle|ruby|php|libwww|httpie|deno|bun|undici|r |httr|rest-client|postman|insomnia|aiohttp|scrapy|got|ky|reqwest|dart)/i;

export function routeOf(pathname: string): UsageRoute | null {
  if (!pathname.startsWith("/api/")) return null;
  if (pathname === "/api/search") return "search";
  if (pathname.startsWith("/api/entities/")) return "entities";
  if (pathname.startsWith("/api/export/")) return "export";
  if (pathname.startsWith("/api/admin/") || pathname.startsWith("/api/ops")) return null;
  return "other_api";
}

export function originOf(headers: Headers): UsageOrigin {
  const site = headers.get("sec-fetch-site");
  if (site === "same-origin") return "site";
  if (site) return "browser_other";
  return "script";
}

export function agentClassOf(userAgent: string): AgentClass {
  if (!userAgent) return "script";
  if (BOT_PATTERN.test(userAgent)) return "bot";
  if (SCRIPT_PATTERN.test(userAgent)) return "script";
  if (userAgent.startsWith("Mozilla/5.0")) return "browser";
  return "script";
}

interface ClientTally {
  client: string;
  agent: string;
  origin: UsageOrigin;
  requests: number;
  limited: number;
  routes: Record<UsageRoute, number>;
}

function emptyRoutes(): Record<UsageRoute, number> {
  return { search: 0, entities: 0, export: 0, other_api: 0 };
}

export interface UsageSummary {
  level: "info";
  event: "api_usage";
  window_start: string;
  window_minutes: number;
  requests: number;
  limited: number;
  by_route: Record<UsageRoute, number>;
  /** Search calls per origin: `site` is the search box on openbesluitvorming.nl. */
  search_by_origin: Record<UsageOrigin, number>;
  search_by_agent: Record<AgentClass, number>;
  clients: number;
  top_clients: Array<{
    client: string;
    agent: string;
    origin: UsageOrigin;
    requests: number;
    limited: number;
    routes: Record<UsageRoute, number>;
  }>;
}

export class UsageTracker {
  private windowStart: number;
  private clients = new Map<string, ClientTally>();
  private byRoute = emptyRoutes();
  private searchByOrigin: Record<UsageOrigin, number> = { site: 0, browser_other: 0, script: 0 };
  private searchByAgent: Record<AgentClass, number> = { browser: 0, bot: 0, script: 0 };
  private requests = 0;
  private limited = 0;

  constructor(
    private readonly emit: (summary: UsageSummary) => void,
    private readonly now: () => number = Date.now,
    private readonly windowMs = USAGE_WINDOW_MS,
  ) {
    this.windowStart = now();
  }

  record(request: Request, client: string, status: number): void {
    const route = routeOf(new URL(request.url).pathname);
    if (!route) return;
    this.rollIfDue();

    const agent = (request.headers.get("user-agent") ?? "").slice(0, MAX_AGENT_LENGTH);
    const origin = originOf(request.headers);
    const isLimited = status === 429;

    this.requests += 1;
    if (isLimited) this.limited += 1;
    this.byRoute[route] += 1;
    if (route === "search") {
      this.searchByOrigin[origin] += 1;
      this.searchByAgent[agentClassOf(agent)] += 1;
    }

    // Per client and user agent, so two programs behind one NAT stay apart.
    const key = `${client}\u0000${agent}`;
    let tally = this.clients.get(key);
    if (!tally) {
      if (this.clients.size >= MAX_TRACKED_CLIENTS) return;
      tally = { client, agent, origin, requests: 0, limited: 0, routes: emptyRoutes() };
      this.clients.set(key, tally);
    }
    tally.requests += 1;
    if (isLimited) tally.limited += 1;
    tally.routes[route] += 1;
  }

  /** Emits the current window if it has ended. Called on every request, and
   * by a timer so a quiet server still closes its window. */
  rollIfDue(): void {
    if (this.now() - this.windowStart >= this.windowMs) {
      this.flush();
    }
  }

  flush(): void {
    if (this.requests > 0) {
      const top = [...this.clients.values()]
        .sort((a, b) => b.requests - a.requests)
        .slice(0, USAGE_TOP_CLIENTS)
        .map((tally) => ({
          // A browser is a person: their address and user agent identify
          // nobody we could write to, and only add to what the line says
          // about them. A script's are how we find and reach its owner.
          client: tally.origin === "script" ? tally.client : "-",
          agent: tally.origin === "script" ? tally.agent : agentClassOf(tally.agent),
          origin: tally.origin,
          requests: tally.requests,
          limited: tally.limited,
          routes: tally.routes,
        }));
      this.emit({
        level: "info",
        event: "api_usage",
        window_start: new Date(this.windowStart).toISOString(),
        window_minutes: Math.round(this.windowMs / 60_000),
        requests: this.requests,
        limited: this.limited,
        by_route: this.byRoute,
        search_by_origin: this.searchByOrigin,
        search_by_agent: this.searchByAgent,
        clients: this.clients.size,
        top_clients: top,
      });
    }
    this.windowStart = this.now();
    this.clients = new Map();
    this.byRoute = emptyRoutes();
    this.searchByOrigin = { site: 0, browser_other: 0, script: 0 };
    this.searchByAgent = { browser: 0, bot: 0, script: 0 };
    this.requests = 0;
    this.limited = 0;
  }
}

/** Told to every search call that does not come from a browser: scripts that
 * read this get pointed at the endpoint built for them. */
export const SEARCH_HARVEST_NOTICE =
  "Zoek je om data in bulk op te halen? Gebruik dan /api/export/snapshot en /api/export/changes: sneller, volledig en zonder rate limit-problemen. Zie https://openbesluitvorming.nl/docs/api#bulk-export";

export function applySearchNotice(request: Request, response: Response): void {
  if (new URL(request.url).pathname !== "/api/search") return;
  if (originOf(request.headers) !== "script") return;
  response.headers.set(
    "Link",
    '<https://openbesluitvorming.nl/docs/api#bulk-export>; rel="help"; title="Bulk export"',
  );
  response.headers.set("X-Openbesluitvorming-Notice", SEARCH_HARVEST_NOTICE);
}
