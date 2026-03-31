import type { SourceDefinitionBase } from "./types.ts";

export type ScopedEntityType = "meeting" | "document" | "committee" | "agenda_item";

export function canonicalOrganizationId(source: SourceDefinitionBase): string {
  return `organization:nl:${source.organizationType}:${source.key}`;
}

export function scopedEntityId(
  entityType: ScopedEntityType,
  source: SourceDefinitionBase,
  nativeId: number | string,
): string {
  return `${entityType}:${source.supplier}:${source.organizationType}:${source.key}:${String(nativeId)}`;
}

export function canonicalMeetingId(
  source: SourceDefinitionBase,
  nativeId: number | string,
): string {
  return scopedEntityId("meeting", source, nativeId);
}

export function canonicalDocumentId(
  source: SourceDefinitionBase,
  nativeId: number | string,
): string {
  return scopedEntityId("document", source, nativeId);
}

export function canonicalCommitteeId(
  source: SourceDefinitionBase,
  nativeId: number | string,
): string {
  return scopedEntityId("committee", source, nativeId);
}

export function canonicalAgendaItemId(
  source: SourceDefinitionBase,
  nativeId: number | string,
): string {
  return scopedEntityId("agenda_item", source, nativeId);
}
