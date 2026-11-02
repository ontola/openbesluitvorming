import type { ExportChangeRecord } from "../src/types.ts";
import { apiError } from "./api_errors.ts";

/** The source key inside a canonical entity id
 * (`<type>:<supplier>:<organization type>:<source key>:<native id>`). */
export function sourceKeyOfEntityId(entityId: string): string | undefined {
  const parts = entityId.split(":");
  return parts.length >= 5 && parts[3] ? parts[3] : undefined;
}

const REASON_TEXT: Record<string, string> = {
  removed_at_source:
    "De bron stelt dit document niet meer beschikbaar. Neem voor de inhoud contact op met de griffie.",
  takedown: "Dit document is op verzoek verwijderd.",
  source_purged: "De bron van dit document wordt niet meer opgenomen.",
};

/** 410 for an entity the export log holds a tombstone for.
 *
 * A removed document answered 404, the same as an id that never existed, so a
 * reader could not tell a typo from a document the griffie took off the
 * agenda, and a consumer had to read the whole change feed to learn why
 * (#343, #350). The tombstone already says why and when. */
export function entityGoneResponse(record: ExportChangeRecord | null): Response | null {
  if (!record || record.op !== "delete") {
    return null;
  }
  return apiError(
    "entity_removed",
    410,
    (record.reason && REASON_TEXT[record.reason]) ?? "Dit resultaat is verwijderd.",
    {
      reason: record.reason ?? null,
      removedAt: record.time,
      ...(record.meeting_id ? { meetingId: record.meeting_id } : {}),
    },
  );
}
