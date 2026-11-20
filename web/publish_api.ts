/** `/api/publish/{source}/meetings`: where an OpenMeeting council publishes
 * its meetings, instead of us polling a supplier API.
 *
 * The council sends a meeting as OpenMeeting exports it (the ORI `Meeting`
 * shape, see src/openmeeting/normalize.ts). We store it as it arrived and
 * queue an import of that meeting's day; the worker then imports it through
 * the same pipeline as every other source, documents included. So a publish
 * answers 202: stored and queued, not yet searchable.
 *
 * Authentication is a bearer token per source, configured with the source in
 * `WOOZI_OPENMEETING_SOURCES`. Like /api/ops this sits outside the public
 * rate limiter and the public error codes: it is a supplier's endpoint, with
 * its own small budget and its own audit line per request. */
import { getCatalogSourceByKey } from "../src/sources/catalog.ts";
import { openMeetingSourceRef, type OpenMeetingSourceConfig } from "../src/openmeeting/sources.ts";
import { type PublishedMeeting, validatePublishedMeeting } from "../src/openmeeting/normalize.ts";
import {
  amsterdamDay,
  PublishedMeetings,
  type PublishedStorage,
} from "../src/openmeeting/published.ts";
import { canonicalMeetingId } from "../src/ids.ts";
import { openMeetingNativeId } from "../src/openmeeting/normalize.ts";
import type { IngestRunRecord, SourceDefinitionBase } from "../src/types.ts";
import { bearerToken, tokensMatch } from "./ops_api.ts";
import { RateLimiter } from "./rate_limit.ts";

export const PUBLISH_PATH_PREFIX = "/api/publish/";
/** A council publishes a meeting at a time, a few dozen at most after an
 * agenda is set. */
const PUBLISH_RATE_LIMIT_PER_MINUTE = 120;
/** A real agenda with a few hundred documents is well under this. */
const MAX_BODY_BYTES = 2_000_000;

export interface PublishApiOptions {
  sources: OpenMeetingSourceConfig[];
  storage: () => Promise<PublishedStorage>;
  /** Queues an import of `sourceRef` for one day; throws when one is already
   * queued or running for that window. */
  startIngest: (sourceRef: string, dateFrom: string, dateTo: string) => Promise<IngestRunRecord>;
  /** The catalog entry of a source key; the real catalog by default. */
  catalogEntry?: (sourceKey: string) => SourceDefinitionBase;
  audit?: (line: string) => void;
  now?: () => number;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function readBody(request: Request): Promise<{ value?: unknown; error?: string }> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) {
    return { error: "De vergadering is te groot." };
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_BODY_BYTES) {
    return { error: "De vergadering is te groot." };
  }
  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { error: "De body is geen geldige JSON." };
  }
}

export function createPublishHandler(
  options: PublishApiOptions,
): (request: Request, client: string) => Promise<Response> {
  const audit = options.audit ?? ((line: string) => console.log(line));
  const now = options.now ?? Date.now;
  const limiter = new RateLimiter(PUBLISH_RATE_LIMIT_PER_MINUTE, now);
  const failedAuthLimiter = new RateLimiter(PUBLISH_RATE_LIMIT_PER_MINUTE, now);
  const sources = new Map(options.sources.map((source) => [source.key, source]));

  return async (request, client) => {
    const url = new URL(request.url);
    const segments = url.pathname.slice(PUBLISH_PATH_PREFIX.length).split("/").filter(Boolean);
    const sourceKey = segments[0] ?? "";
    const finish = (response: Response, fields: Record<string, unknown>): Response => {
      audit(
        JSON.stringify({
          level: response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "info",
          event: "publish_request",
          method: request.method,
          path: url.pathname,
          source: sourceKey,
          client,
          status: response.status,
          ...fields,
        }),
      );
      return response;
    };

    const source = sources.get(sourceKey);
    const presented = bearerToken(request);
    // An unknown source and a wrong token answer alike, so the endpoint does
    // not tell a guesser which councils publish here.
    if (!source || presented === null || !(await tokensMatch(presented, source.token))) {
      const verdict = failedAuthLimiter.consume(`ip:${client}`, 1);
      if (!verdict.allowed) {
        return finish(json({ error: "Te veel verzoeken." }, 429), { outcome: "rate_limited" });
      }
      const response = json({ error: "Ontbrekend of ongeldig token voor deze bron." }, 401);
      response.headers.set("WWW-Authenticate", 'Bearer realm="woozi-publish"');
      return finish(response, { outcome: presented === null ? "missing_token" : "invalid_token" });
    }

    const verdict = limiter.consume(`source:${source.key}`, 1);
    if (!verdict.allowed) {
      const response = json({ error: "Te veel verzoeken." }, 429);
      response.headers.set("Retry-After", String(verdict.retryAfterSeconds));
      return finish(response, { outcome: "rate_limited" });
    }

    if (segments.length !== 2 || segments[1] !== "meetings") {
      return finish(json({ error: "Niet gevonden." }, 404), { outcome: "not_found" });
    }

    try {
      const store = new PublishedMeetings(await options.storage());
      // The catalog entry, so a source configured but rejected by the catalog
      // (a duplicate key) fails here, loudly, instead of storing meetings no
      // import will ever read.
      const entry = (options.catalogEntry ?? getCatalogSourceByKey)(source.key);

      if (request.method === "PUT" || request.method === "POST") {
        const body = await readBody(request);
        if (body.error) {
          return finish(json({ error: body.error }, 400), { outcome: "invalid_body" });
        }
        const problems = validatePublishedMeeting(body.value);
        if (problems.length > 0) {
          return finish(json({ error: "De vergadering klopt niet.", problems }, 400), {
            outcome: "invalid_meeting",
            problems: problems.length,
          });
        }
        const meeting = body.value as PublishedMeeting;
        await store.put(source.key, meeting, new Date(now()));
        const day = amsterdamDay(meeting.start_date);
        let run: { id: string; status: string } | null = null;
        let note: string | undefined;
        try {
          const started = await options.startIngest(openMeetingSourceRef(source), day, day);
          run = { id: started.id, status: started.status };
        } catch (error) {
          // A run for this day is already queued or running. A queued one
          // reads the store when it starts and so picks this version up; one
          // already past the listing does not, and the nightly import (which
          // covers -7..+28 days) does.
          note = error instanceof Error ? error.message : String(error);
        }
        const meetingId = canonicalMeetingId(entry, await openMeetingNativeId(meeting.id));
        return finish(
          json(
            {
              stored: true,
              meeting_id: meetingId,
              day,
              run,
              ...(note ? { note } : {}),
            },
            202,
          ),
          { outcome: "stored", meeting_id: meetingId, run_id: run?.id },
        );
      }

      const id = url.searchParams.get("id")?.trim() ?? "";
      if (!id) {
        return finish(json({ error: "Geef de vergadering mee als ?id=." }, 400), {
          outcome: "missing_id",
        });
      }

      if (request.method === "GET") {
        const meeting = await store.get(source.key, id);
        return meeting
          ? finish(json({ meeting }), { outcome: "ok" })
          : finish(json({ error: "Niet gepubliceerd." }, 404), { outcome: "not_found" });
      }

      if (request.method === "DELETE") {
        const removed = await store.remove(source.key, id);
        return finish(
          json({
            removed,
            note: "Niet meer gepubliceerd. Wat al geïmporteerd is, blijft vindbaar tot het wordt ingetrokken.",
          }),
          { outcome: removed ? "removed" : "not_found" },
        );
      }

      const response = json({ error: "Methode niet toegestaan." }, 405);
      response.headers.set("Allow", "PUT, POST, GET, DELETE");
      return finish(response, { outcome: "method_not_allowed" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return finish(json({ error: "Publiceren mislukt." }, 500), {
        outcome: "error",
        error: message,
      });
    }
  };
}
