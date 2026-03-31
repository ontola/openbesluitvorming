import type {
  DocumentEntity,
  MeetingEntity,
  NotubizOrganizationAttributes,
  NotubizSourceDefinition,
} from "../types.ts";

function canonicalId(source: NotubizSourceDefinition, meetingId: number | string): string {
  return `meeting:notubiz:${source.key}:${meetingId}`;
}

function canonicalOrganizationId(source: NotubizSourceDefinition): string {
  return `organization:allmanak:${source.key}:${source.allmanakId}`;
}

function canonicalCommitteeId(
  source: NotubizSourceDefinition,
  committeeId: number | string,
): string {
  return `committee:notubiz:${source.key}:${committeeId}`;
}

function canonicalAgendaItemId(
  source: NotubizSourceDefinition,
  agendaItemId: number | string,
): string {
  return `agenda_item:notubiz:${source.key}:${agendaItemId}`;
}

function collectAgendaIds(source: NotubizSourceDefinition, agendaItems: unknown[]): string[] {
  const result: string[] = [];

  function walk(items: unknown[]) {
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const id = record.id;
      if (typeof id === "number" || typeof id === "string") {
        result.push(canonicalAgendaItemId(source, id));
      }
      const children = Array.isArray(record.agenda_items) ? record.agenda_items : [];
      walk(children);
    }
  }

  walk(agendaItems);
  return result;
}

function collectAttachmentIds(
  source: NotubizSourceDefinition,
  meeting: Record<string, unknown>,
): string[] {
  const result: string[] = [];

  const topLevelDocuments = Array.isArray(meeting.documents) ? meeting.documents : [];
  for (const doc of topLevelDocuments) {
    if (!doc || typeof doc !== "object") continue;
    const id = (doc as Record<string, unknown>).id;
    if (typeof id === "number" || typeof id === "string") {
      result.push(canonicalDocumentId(source, id));
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
        result.push(canonicalDocumentId(source, id));
      }
    }
  }

  return [...new Set(result)];
}

function canonicalDocumentId(source: NotubizSourceDefinition, documentId: number | string): string {
  return `document:notubiz:${source.key}:${documentId}`;
}

function collectAgendaDocuments(agendaItems: unknown[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];

  function walk(items: unknown[]) {
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const documents = Array.isArray(record.documents) ? record.documents : [];
      for (const document of documents) {
        if (document && typeof document === "object") {
          result.push(document as Record<string, unknown>);
        }
      }

      const children = Array.isArray(record.agenda_items) ? record.agenda_items : [];
      walk(children);
    }
  }

  walk(agendaItems);
  return result;
}

function normalizeContentType(document: Record<string, unknown>): string | undefined {
  const versions = Array.isArray(document.versions) ? document.versions : [];
  const firstVersion =
    versions[0] && typeof versions[0] === "object"
      ? (versions[0] as Record<string, unknown>)
      : null;
  return typeof firstVersion?.mime_type === "string" ? firstVersion.mime_type : undefined;
}

function normalizeFileName(document: Record<string, unknown>): string | undefined {
  const versions = Array.isArray(document.versions) ? document.versions : [];
  const firstVersion =
    versions[0] && typeof versions[0] === "object"
      ? (versions[0] as Record<string, unknown>)
      : null;
  return typeof firstVersion?.file_name === "string" ? firstVersion.file_name : undefined;
}

function normalizeFileSize(document: Record<string, unknown>): number | undefined {
  const versions = Array.isArray(document.versions) ? document.versions : [];
  const firstVersion =
    versions[0] && typeof versions[0] === "object"
      ? (versions[0] as Record<string, unknown>)
      : null;
  return typeof firstVersion?.file_size === "number" ? firstVersion.file_size : undefined;
}

function documentClassification(document: Record<string, unknown>): string[] | undefined {
  const types = Array.isArray(document.types) ? document.types : [];
  const values = types
    .map((item) => {
      if (!item || typeof item !== "object") return undefined;
      return typeof (item as Record<string, unknown>).value === "string"
        ? ((item as Record<string, unknown>).value as string)
        : undefined;
    })
    .filter((value): value is string => Boolean(value));

  return values.length > 0 ? values : undefined;
}

function normalizeDateTime(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  return normalized.endsWith("Z") ? normalized : `${normalized}Z`;
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
    organization: canonicalOrganizationId(source),
    committee:
      typeof gremiumId === "number" || typeof gremiumId === "string"
        ? canonicalCommitteeId(source, gremiumId)
        : undefined,
    agenda: collectAgendaIds(source, Array.isArray(record.agenda_items) ? record.agenda_items : []),
    attachment: collectAttachmentIds(source, record),
    source_info: {
      supplier: "notubiz",
      source: source.key,
      canonical_id: meetingId,
      canonical_iri: `https://api.notubiz.nl/events/meetings/${meetingId}`,
    },
    raw: meeting,
  };
}

export function normalizeNotubizDocuments(
  source: NotubizSourceDefinition,
  meeting: MeetingEntity,
): DocumentEntity[] {
  if (!meeting.raw || typeof meeting.raw !== "object") {
    return [];
  }

  const record = meeting.raw as Record<string, unknown>;
  const directDocuments = Array.isArray(record.documents)
    ? record.documents.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === "object"),
      )
    : [];
  const agendaDocuments = collectAgendaDocuments(
    Array.isArray(record.agenda_items) ? record.agenda_items : [],
  );

  const documentsById = new Map<string, Record<string, unknown>>();
  for (const document of [...directDocuments, ...agendaDocuments]) {
    const id = document.id;
    if (typeof id === "number" || typeof id === "string") {
      documentsById.set(String(id), document);
    }
  }

  return [...documentsById.entries()].map(([documentId, document]) => ({
    id: canonicalDocumentId(source, documentId),
    type: "Document",
    name:
      typeof document.title === "string" && document.title.length > 0
        ? document.title
        : (normalizeFileName(document) ?? `Document ${documentId}`),
    classification: documentClassification(document),
    original_url: typeof document.url === "string" ? document.url : undefined,
    identifier_url:
      typeof document.self === "string"
        ? `https://${document.self.replace(/^https?:\/\//, "")}`
        : undefined,
    file_name: normalizeFileName(document),
    content_type: normalizeContentType(document),
    size_in_bytes: normalizeFileSize(document),
    date_modified: normalizeDateTime(document.last_modified),
    last_discussed_at: meeting.last_discussed_at,
    is_referenced_by: meeting.id,
    organization: meeting.organization,
    source_info: {
      supplier: "notubiz",
      source: source.key,
      canonical_id: documentId,
      canonical_iri:
        typeof document.url === "string"
          ? document.url
          : `https://api.notubiz.nl/document/${documentId}/1`,
      source_iri: meeting.source_info.canonical_iri,
    },
    raw: document,
  }));
}
