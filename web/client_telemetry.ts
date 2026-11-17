/** Who calls /api/*, as far as the trace may say.
 *
 * Deno's built-in OpenTelemetry (OTEL_DENO) records a server span per request
 * with method, path and status, but nothing about the caller. That left one
 * question unanswerable on 2026-10-29: which reusers of the old ORI API have
 * moved here. The answer needs two things per API request, and both go on the
 * span that is already being sent to SigNoz:
 *
 * - `user_agent.original`: API clients mostly name themselves there, often
 *   with a contact address ("NeoDemos-Collector/0.3 (+https://neodemos.nl/bot)").
 * - `client.id`: the caller's IP, hashed with a salt that is drawn at random
 *   and replaced every UTC day. Within a day it counts and follows one client;
 *   after the day nobody, us included, can turn it back into an address. The
 *   raw IP never leaves this process, which is what the privacy section of the
 *   site promises ("Je IP-adres wordt niet bewaard").
 *
 * Only /api/* is annotated. Page views are Swetrix's business and stay out of
 * the traces.
 */

import { trace } from "npm:@opentelemetry/api@^1.9.0";

const CLIENT_ID_HEX_LENGTH = 16;

export type DailySalt = { day: string; salt: Uint8Array };

let currentSalt: DailySalt | null = null;

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The salt for `now`'s UTC day, drawing a fresh one when the day has turned.
 * Kept in memory only, so a restart also forgets it -- that only shortens the
 * window in which two requests can be linked. */
export function dailySalt(now = new Date()): DailySalt {
  const day = utcDay(now);
  if (currentSalt?.day !== day) {
    currentSalt = { day, salt: crypto.getRandomValues(new Uint8Array(32)) };
  }
  return currentSalt;
}

export async function hashClient(address: string, salt: Uint8Array): Promise<string> {
  const input = new Uint8Array(salt.length + address.length * 3);
  input.set(salt, 0);
  const encoded = new TextEncoder().encodeInto(address, input.subarray(salt.length));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    input.subarray(0, salt.length + encoded.written),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, CLIENT_ID_HEX_LENGTH);
}

/** Puts the caller's user agent and daily client id on the active server
 * span. A no-op when telemetry is off or the path is not part of the API. */
export async function annotateApiSpan(
  request: Request,
  pathname: string,
  clientAddress: string,
): Promise<void> {
  if (!pathname.startsWith("/api/")) {
    return;
  }
  const span = trace.getActiveSpan();
  if (!span || !span.isRecording()) {
    return;
  }
  const userAgent = request.headers.get("user-agent");
  if (userAgent) {
    span.setAttribute("user_agent.original", userAgent.slice(0, 300));
  }
  if (clientAddress !== "unknown") {
    span.setAttribute("client.id", await hashClient(clientAddress, dailySalt().salt));
  }
}
