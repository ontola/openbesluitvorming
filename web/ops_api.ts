/**
 * `/api/ops/*`: an authenticated endpoint for operating the import pipeline
 * without a shell on the server.
 *
 * Separate from `/api/admin/*`, which sits behind Caddy basic auth and serves
 * the admin UI. This one authenticates itself with a bearer token from
 * `WOOZI_OPS_TOKEN`; when that is unset the whole route answers 404, as if it
 * did not exist.
 *
 * Reads (`GET runs`, `summary`, one run, jobs) answer directly. Mutating
 * actions never run here: they are validated and queued as an `ops_job` row,
 * and a worker executes them (see src/ops/jobs.ts). Every request, including
 * a rejected one, writes one structured audit line; the token never appears
 * in it.
 *
 * Not a public contract, so errors are plain English `{ error }` bodies
 * without the `code` field of the public API. Documented in deployment.md.
 */

import {
  createOpsJob,
  getOpsJob,
  getRunDetails,
  getRunSummary,
  listOpsJobs,
  listRuns,
  OpsJobConflictError,
} from "../src/ops/store.ts";
import { isOpsAction, OpsValidationError, validateOpsRequest } from "../src/ops/jobs.ts";
import { RateLimiter } from "./rate_limit.ts";

export const OPS_PATH_PREFIX = "/api/ops/";
export const OPS_RATE_LIMIT_PER_MINUTE = 30;

const MAX_ACTOR_LENGTH = 100;
const MAX_LIST_LIMIT = 200;

export interface OpsApiOptions {
  /** The bearer token. Empty or undefined disables the endpoint (404). */
  token: string | undefined;
  /** Where the audit line goes; defaults to stdout. */
  audit?: (line: string) => void;
  now?: () => number;
}

interface AuditFields {
  outcome: string;
  status: number;
  action?: string;
  apply?: boolean;
  job_id?: string;
  error?: string;
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/** Compare two secrets in time independent of where they differ. Hashing
 * first also hides the expected token's length. */
export async function tokensMatch(presented: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(presented), sha256(expected)]);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a[index] ^ b[index];
  }
  return difference === 0;
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function actorOf(request: Request): string {
  const actor = request.headers.get("x-ops-actor")?.trim();
  if (!actor) {
    return "unknown";
  }
  // Printable ASCII only: the actor lands in log lines and in the job row.
  return actor.replace(/[^\x20-\x7e]/g, "?").slice(0, MAX_ACTOR_LENGTH);
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function listParams(url: URL): { limit: number; offset: number } {
  const limit = Number(url.searchParams.get("limit") ?? "50");
  const offset = Number(url.searchParams.get("offset") ?? "0");
  return {
    limit: Number.isFinite(limit) ? Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(limit))) : 50,
    offset: Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0,
  };
}

export function createOpsHandler(
  options: OpsApiOptions,
): (request: Request, client: string) => Promise<Response> {
  const token = options.token?.trim() ?? "";
  const audit = options.audit ?? ((line: string) => console.log(line));
  const limiter = new RateLimiter(OPS_RATE_LIMIT_PER_MINUTE, options.now);
  // Failed authentication is limited per client address, so guessing costs
  // the same as using the endpoint and cannot drain the token's own budget.
  const failedAuthLimiter = new RateLimiter(OPS_RATE_LIMIT_PER_MINUTE, options.now);

  return async (request, client) => {
    const url = new URL(request.url);
    const actor = actorOf(request);

    const finish = (response: Response, fields: AuditFields): Response => {
      audit(
        JSON.stringify({
          level: fields.status >= 500 ? "error" : fields.status >= 400 ? "warn" : "info",
          event: "ops_request",
          method: request.method,
          path: url.pathname,
          actor,
          client,
          ...fields,
        }),
      );
      return response;
    };

    if (!token) {
      // Indistinguishable from any other unknown path.
      return finish(new Response("Niet gevonden", { status: 404 }), {
        outcome: "disabled",
        status: 404,
      });
    }

    const presented = bearerToken(request);
    if (presented === null || !(await tokensMatch(presented, token))) {
      const verdict = failedAuthLimiter.consume(`ip:${client}`, 1);
      if (!verdict.allowed) {
        return finish(json({ error: "Too many requests." }, 429), {
          outcome: "rate_limited",
          status: 429,
        });
      }
      const response = json({ error: "Missing or invalid bearer token." }, 401);
      response.headers.set("WWW-Authenticate", 'Bearer realm="woozi-ops"');
      return finish(response, {
        outcome: presented === null ? "missing_token" : "invalid_token",
        status: 401,
      });
    }

    // One token, so one bucket. Keyed on a constant rather than the token so
    // the secret is not kept as a map key.
    const verdict = limiter.consume("token", 1);
    if (!verdict.allowed) {
      const response = json({ error: "Too many requests." }, 429);
      response.headers.set("Retry-After", String(verdict.retryAfterSeconds));
      return finish(response, { outcome: "rate_limited", status: 429 });
    }

    try {
      return await route(request, url, actor, finish);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return finish(json({ error: message }, 500), {
        outcome: "error",
        status: 500,
        error: message,
      });
    }
  };
}

async function route(
  request: Request,
  url: URL,
  actor: string,
  finish: (response: Response, fields: AuditFields) => Response,
): Promise<Response> {
  const path = url.pathname.slice(OPS_PATH_PREFIX.length).replace(/\/+$/, "");
  const segments = path.split("/").filter(Boolean);
  const ok = (body: unknown) => finish(json(body), { outcome: "ok", status: 200 });
  const notFound = (error = "Not found.") =>
    finish(json({ error }, 404), { outcome: "not_found", status: 404 });

  if (request.method === "GET") {
    if (path === "runs") {
      const { limit, offset } = listParams(url);
      const runs = await listRuns({
        sourceKey: url.searchParams.get("source") ?? undefined,
        status: url.searchParams.get("status") ?? undefined,
        limit: limit + 1,
        offset,
      });
      return ok({ runs: runs.slice(0, limit), hasMore: runs.length > limit });
    }
    if (path === "summary") {
      return ok({ summary: await getRunSummary() });
    }
    if (segments[0] === "runs" && segments.length === 2) {
      const details = await getRunDetails(segments[1]);
      return details ? ok(details) : notFound("Run not found.");
    }
    if (path === "jobs") {
      const { limit, offset } = listParams(url);
      const jobs = await listOpsJobs({
        status: url.searchParams.get("status") ?? undefined,
        limit: limit + 1,
        offset,
      });
      return ok({ jobs: jobs.slice(0, limit), hasMore: jobs.length > limit });
    }
    if (segments[0] === "jobs" && segments.length === 2) {
      const job = await getOpsJob(segments[1]);
      return job ? ok({ job }) : notFound("Job not found.");
    }
    return notFound();
  }

  if (request.method === "POST" && segments.length === 1 && isOpsAction(segments[0])) {
    const action = segments[0];
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return finish(json({ error: "Request body must be JSON." }, 400), {
        outcome: "bad_request",
        status: 400,
        action,
      });
    }
    let validated;
    try {
      validated = validateOpsRequest(action, body);
    } catch (error) {
      if (error instanceof OpsValidationError) {
        return finish(json({ error: error.message }, 400), {
          outcome: "bad_request",
          status: 400,
          action,
          error: error.message,
        });
      }
      throw error;
    }
    try {
      const job = await createOpsJob({
        action,
        params: validated.params as unknown as Record<string, unknown>,
        apply: validated.apply,
        actor,
      });
      return finish(json({ job }, 202), {
        outcome: "queued",
        status: 202,
        action,
        apply: validated.apply,
        job_id: job.id,
      });
    } catch (error) {
      if (error instanceof OpsJobConflictError) {
        return finish(
          json(
            {
              error: "Another apply job is still queued or running.",
              activeJobId: error.activeJobId,
            },
            409,
          ),
          { outcome: "conflict", status: 409, action, apply: validated.apply },
        );
      }
      throw error;
    }
  }

  return finish(json({ error: "Method not allowed or unknown action." }, 405), {
    outcome: "method_not_allowed",
    status: 405,
  });
}
