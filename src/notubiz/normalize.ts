import type {
  MeetingEntity,
  NotubizOrganizationAttributes,
  NotubizSourceDefinition,
} from "../types.ts";

function canonicalId(source: NotubizSourceDefinition, meetingId: number | string): string {
  return `meeting:notubiz:${source.key}:${meetingId}`;
}

function collectAgendaIds(agendaItems: unknown[]): string[] {
  const result: string[] = [];

  function walk(items: unknown[]) {
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const id = record.id;
      if (typeof id === "number" || typeof id === "string") {
        result.push(`agenda_item:notubiz:${String(id)}`);
      }
      const children = Array.isArray(record.agenda_items) ? record.agenda_items : [];
      walk(children);
    }
  }

  walk(agendaItems);
  return result;
}

function collectAttachmentIds(meeting: Record<string, unknown>): string[] {
  const result: string[] = [];

  const topLevelDocuments = Array.isArray(meeting.documents) ? meeting.documents : [];
  for (const doc of topLevelDocuments) {
    if (!doc || typeof doc !== "object") continue;
    const id = (doc as Record<string, unknown>).id;
    if (typeof id === "number" || typeof id === "string") {
      result.push(`document:notubiz:${String(id)}`);
    }
  }

  const agendaItems = Array.isArray(meeting.agenda_items) ? meeting.agenda_items : [];
  for (const item of agendaItems) {
    if (!item || typeof item !== "object") continue;
    const docs = Array.isArray((item as Record<string, unknown>).documents)
      ? ((item as Record<string, unknown>).documents as unknown[])
      : [];
    for (const doc of docs) {
      if (!doc || typeof doc !== "object") continue;
      const id = (doc as Record<string, unknown>).id;
      if (typeof id === "number" || typeof id === "string") {
        result.push(`document:notubiz:${String(id)}`);
      }
    }
  }

  return [...new Set(result)];
}

export function normalizeNotubizMeeting(
  source: NotubizSourceDefinition,
  attributes: NotubizOrganizationAttributes,
  meeting: unknown,
): MeetingEntity {
  if (!meeting || typeof meeting !== "object") {
    throw new Error("Meeting payload is not an object");
  }

  const record = meeting as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== "number" && typeof id !== "string") {
    throw new Error("Meeting payload has no id");
  }

  const plannings = Array.isArray(record.plannings) ? record.plannings : [];
  const firstPlanning = (plannings[0] ?? {}) as Record<string, unknown>;
  const startDate = firstPlanning.start_date;
  const endDate = firstPlanning.end_date;
  if (typeof startDate !== "string") {
    throw new Error(`Meeting ${String(id)} has no planning start_date`);
  }

  const rawAttributes = Array.isArray(record.attributes) ? record.attributes : [];
  const mappedAttributes: Record<string, string> = {};
  for (const item of rawAttributes) {
    if (!item || typeof item !== "object") continue;
    const attr = item as Record<string, unknown>;
    const attrId = attr.id;
    const value = attr.value;
    if (typeof attrId === "string" && typeof value === "string") {
      const label = attributes.attributes[attrId];
      if (label) {
        mappedAttributes[label] = value;
      }
    }
  }

  const gremium =
    record.gremium && typeof record.gremium === "object"
      ? (record.gremium as Record<string, unknown>)
      : undefined;
  const gremiumId = gremium?.id;
  const meetingId = String(id);

  const name = mappedAttributes.Titel || `Vergadering ${startDate}`;
  const status =
    record.canceled === true
      ? "EventCancelled"
      : record.inactive === true
        ? "EventConfirmed"
        : "EventUnconfirmed";

  return {
    id: canonicalId(source, meetingId),
    type: "Meeting",
    name,
    classification: ["Agenda"],
    status,
    location: mappedAttributes.Locatie,
    start_date: startDate,
    end_date: typeof endDate === "string" ? endDate : undefined,
    last_discussed_at: startDate,
    organization: `organization:allmanak:${source.allmanakId}`,
    committee:
      typeof gremiumId === "number" || typeof gremiumId === "string"
        ? `committee:notubiz:${String(gremiumId)}`
        : undefined,
    agenda: collectAgendaIds(Array.isArray(record.agenda_items) ? record.agenda_items : []),
    attachment: collectAttachmentIds(record),
    source_info: {
      supplier: "notubiz",
      source: source.key,
      canonical_id: meetingId,
      canonical_iri: `https://api.notubiz.nl/events/meetings/${meetingId}`,
    },
    raw: meeting,
  };
}
