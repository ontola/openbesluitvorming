/** The parts of the ODS Open Raadsinformatie event polling spec (version
 * 0.0.3, VNG-Realisatie/ODS-Open-Raadsinformatie, `docs/event polling/versie
 * 0.0.3/openapi.yaml`) that we read. Field names are the spec's own; only what
 * we use is typed, the rest stays in `raw`. */

export type OdsResourceType = "Vergadering" | "Agendapunt" | "Informatieobject";
export const ODS_RESOURCE_TYPES: OdsResourceType[] = [
  "Vergadering",
  "Agendapunt",
  "Informatieobject",
];

export interface OdsResourceKey {
  organisatiecode: string;
  bronidentificatie: string;
}

export interface OdsReference {
  bronidentificatie: string;
  organisatiecode?: string;
  url?: string;
}

export interface OdsVergadering {
  bronidentificatie: string;
  url?: string;
  dossiertype: "vergadering";
  webpaginalink?: string;
  naam: string;
  aanvang?: string;
  einde?: string;
  geplandeaanvang?: string;
  geplandeeinde?: string;
  geplandedatum?: string;
  vergaderdatum?: string;
  locatie?: string;
  vergaderstatus?: string;
  vergaderingstype?: string;
  vergadertoelichting?: string;
  georganiseerddoorgremium?: { gremiumidentificatie: string; gremiumnaam: string };
  hoofdvergadering?: OdsReference;
  agendapunten?: OdsReference[];
}

export interface OdsAgendapunt {
  bronidentificatie: string;
  url?: string;
  dossiertype: "agendapunt";
  webpaginalink?: string;
  agendapuntnaam: string;
  vergadering: OdsReference;
  hoofdagendapunt?: OdsReference;
  omschrijving?: string;
  volgnummer?: string;
  geplandvolgnummer?: string;
  tussenkop?: string;
  starttijd?: string;
  geplandestarttijd?: string;
  indicatiehamerstuk?: boolean | null;
  indicatiebesloten?: boolean | null;
}

export interface OdsInformatieobject {
  bronidentificatie: string;
  url?: string;
  dossiertype: "informatieobject";
  webpaginalink?: string;
  bestandsurl?: string;
  formaat?: string;
  omvang?: number;
  checksum?: string;
  titel: string;
  wooinformatiecategorie?: string;
  datumingediend?: string;
  informatieobjecttype?: string;
  omschrijving?: string;
  vergaderingen?: OdsReference[];
  agendapunten?: OdsReference[];
}

export type OdsResource = OdsVergadering | OdsAgendapunt | OdsInformatieobject;

export interface OdsFeedRecord {
  sequenceNumber: number;
  op: "upsert" | "delete" | "redact";
  resourceType: OdsResourceType | string;
  resource: OdsResourceKey;
  contentHash?: string;
  storedAt: string;
  data?: OdsResource;
  verwijderreden?: string;
  toelichting?: string;
  geredigeerdeSequenceNumbers?: number[];
}

export interface OdsFeedPage {
  records: OdsFeedRecord[];
  cursor: string;
  head: number;
  hasMore: boolean;
}

export interface OdsSnapshotPage {
  records: OdsFeedRecord[];
  feedCursor: string;
  cursor?: string | null;
  hasMore: boolean;
}

/** The feed said our cursor is no good (400): it fell out of the retention,
 * or the feed was reset. The way back is the snapshot. */
export class OdsCursorRejectedError extends Error {}

const PAGE_LIMIT = 500;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;

/** Reads one feed. Every request has a timeout (AGENTS.md, "Outbound HTTP"),
 * 429 and 503 are retried after their Retry-After, and the organisation
 * filter is always sent, so a feed that serves several organisations only
 * gives us this one. */
export class OdsFeedClient {
  constructor(
    private readonly feedUrl: string,
    private readonly organisatiecode: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  feed(cursor?: string, limit = PAGE_LIMIT): Promise<OdsFeedPage> {
    return this.get<OdsFeedPage>("feed", cursor, limit);
  }

  snapshot(cursor?: string, limit = PAGE_LIMIT): Promise<OdsSnapshotPage> {
    return this.get<OdsSnapshotPage>("snapshot", cursor, limit);
  }

  private async get<T>(path: "feed" | "snapshot", cursor: string | undefined, limit: number) {
    const url = new URL(`${this.feedUrl}/${path}`);
    url.searchParams.set("organisatiecode", this.organisatiecode);
    url.searchParams.set("limit", String(limit));
    if (cursor) url.searchParams.set("cursor", cursor);

    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetcher(url, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            accept: "application/json",
            "user-agent": "woozi/0.1 (openbesluitvorming.nl)",
          },
        });
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS) throw error;
        await this.sleep(1000 * attempt);
        continue;
      }
      if (response.ok) {
        return (await response.json()) as T;
      }
      const detail = await response.text().catch(() => "");
      if (response.status === 400 && cursor) {
        throw new OdsCursorRejectedError(
          `${path} refused cursor ${cursor}: ${detail.slice(0, 300)}`,
        );
      }
      if ((response.status === 429 || response.status >= 500) && attempt < MAX_ATTEMPTS) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await this.sleep(
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * attempt,
        );
        continue;
      }
      throw new Error(`${path} answered ${response.status} for ${url}: ${detail.slice(0, 300)}`);
    }
  }
}
