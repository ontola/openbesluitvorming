import {
  canonicalAgendaItemId,
  canonicalCommitteeId,
  canonicalDocumentId,
  canonicalMeetingId,
  canonicalOrganizationId,
} from "../ids.ts";
import type {
  CommitteeEntity,
  DocumentEntity,
  MeetingAgendaItem,
  MeetingEntity,
  SourceDefinitionBase,
} from "../types.ts";

/** A meeting as OpenMeeting publishes it: the ORI `Meeting` export of
 * `lib/data/ori.dart` (`Ori.meeting`), which keeps the field names of
 * `schemas/meeting.schema.json`. Only what we read is typed here; the rest
 * is kept in `raw`.
 *
 * Ids are what OpenMeeting calls the resource: its Atomic subject (a URL),
 * or the ORI id it was imported under. They are turned into our own scoped
 * ids, so a published id can never claim another source's entity. */
export interface PublishedMeeting {
  id: string;
  type?: "Meeting";
  name: string;
  status?: string;
  description?: string;
  location?: string;
  start_date: string;
  end_date?: string;
  committee?: string;
  committee_name?: string;
  classification?: string[];
  agenda?: PublishedAgendaItem[];
}

export interface PublishedAgendaItem {
  id: string;
  parent?: string;
  title?: string;
  description?: string;
  number?: string | number;
  order?: number;
  is_heading?: boolean;
  classification?: string;
  documents?: PublishedDocument[];
}

export interface PublishedDocument {
  id: string;
  name: string;
  classification?: string;
  /** The document's text where OpenMeeting holds one (a summary, or the
   * whole of a document written in the app). */
  description?: string;
  original_url?: string;
  file_name?: string;
  content_type?: string;
}

/** Limits on one published meeting. Generous for a real agenda, small enough
 * that one request cannot fill the store. */
export const PUBLISH_LIMITS = {
  agendaItems: 500,
  documentsPerItem: 200,
  textLength: 200_000,
  idLength: 500,
};

/** Whether the worker may download [value]: https on a public host name.
 * The worker fetches every `original_url`, from inside our network, so an
 * address like `http://quickwit:7280` or `https://10.0.0.2` must never get
 * that far. IP literals and single-label names are refused outright. */
export function isPublicHttpsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host.endsWith(".localhost") || host.endsWith(".internal")) {
    return false;
  }
  // IPv4 literal, or IPv6 (URL keeps the brackets).
  if (/^\d+(\.\d+){3}$/.test(host) || host.startsWith("[")) return false;
  return true;
}

/** What is wrong with a published meeting, in Dutch, for the publisher.
 * Empty when it can be stored. Checked on arrival, so the extractor only
 * ever reads meetings that passed. */
export function validatePublishedMeeting(value: unknown): string[] {
  const problems: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["De vergadering moet een JSON-object zijn."];
  }
  const meeting = value as Record<string, unknown>;
  const text = (field: unknown, path: string, required: boolean) => {
    if (field === undefined || field === null) {
      if (required) problems.push(`${path} ontbreekt.`);
      return;
    }
    if (typeof field !== "string") {
      problems.push(`${path} moet tekst zijn.`);
      return;
    }
    if (required && !field.trim()) problems.push(`${path} is leeg.`);
    if (field.length > PUBLISH_LIMITS.textLength) problems.push(`${path} is te lang.`);
  };
  const id = (field: unknown, path: string) => {
    text(field, path, true);
    if (typeof field === "string" && field.length > PUBLISH_LIMITS.idLength) {
      problems.push(`${path} is te lang.`);
    }
  };
  const url = (field: unknown, path: string) => {
    if (field === undefined || field === null) return;
    if (typeof field !== "string" || !isPublicHttpsUrl(field)) {
      problems.push(`${path} moet een openbaar https-adres zijn.`);
    }
  };

  id(meeting.id, "id");
  if (meeting.type !== undefined && meeting.type !== "Meeting") {
    problems.push('type moet "Meeting" zijn.');
  }
  text(meeting.name, "name", true);
  text(meeting.description, "description", false);
  text(meeting.location, "location", false);
  text(meeting.status, "status", false);
  text(meeting.committee_name, "committee_name", false);
  if (meeting.committee !== undefined) id(meeting.committee, "committee");
  for (const field of ["start_date", "end_date"] as const) {
    const raw = meeting[field];
    if (raw === undefined && field === "end_date") continue;
    if (
      typeof raw !== "string" ||
      Number.isNaN(Date.parse(raw)) ||
      !/[zZ]|[+-]\d\d:?\d\d$/.test(raw)
    ) {
      problems.push(`${field} moet een datum met tijdzone zijn (ISO 8601).`);
    }
  }

  const agenda = meeting.agenda ?? [];
  if (!Array.isArray(agenda)) {
    problems.push("agenda moet een lijst zijn.");
    return problems;
  }
  if (agenda.length > PUBLISH_LIMITS.agendaItems) {
    problems.push(`agenda heeft meer dan ${PUBLISH_LIMITS.agendaItems} punten.`);
    return problems;
  }
  agenda.forEach((raw, index) => {
    const path = `agenda[${index}]`;
    if (!raw || typeof raw !== "object") {
      problems.push(`${path} moet een object zijn.`);
      return;
    }
    const item = raw as Record<string, unknown>;
    id(item.id, `${path}.id`);
    text(item.title, `${path}.title`, false);
    text(item.description, `${path}.description`, false);
    if (item.parent !== undefined) id(item.parent, `${path}.parent`);
    const documents = item.documents ?? [];
    if (!Array.isArray(documents)) {
      problems.push(`${path}.documents moet een lijst zijn.`);
      return;
    }
    if (documents.length > PUBLISH_LIMITS.documentsPerItem) {
      problems.push(`${path}.documents heeft meer dan ${PUBLISH_LIMITS.documentsPerItem} stukken.`);
      return;
    }
    documents.forEach((rawDoc, docIndex) => {
      const docPath = `${path}.documents[${docIndex}]`;
      if (!rawDoc || typeof rawDoc !== "object") {
        problems.push(`${docPath} moet een object zijn.`);
        return;
      }
      const doc = rawDoc as Record<string, unknown>;
      id(doc.id, `${docPath}.id`);
      text(doc.name, `${docPath}.name`, true);
      text(doc.classification, `${docPath}.classification`, false);
      text(doc.description, `${docPath}.description`, false);
      url(doc.original_url, `${docPath}.original_url`);
    });
  });
  return problems;
}

/** Our native id for an OpenMeeting id. Atomic subjects are URLs, which make
 * poor path segments in our own ids, so they become a short stable hash; the
 * subject itself stays in `source_info.canonical_iri`. */
export async function openMeetingNativeId(id: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
  return [...new Uint8Array(digest).slice(0, 10)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function trimmed(value: string | undefined): string | undefined {
  const out = value?.trim();
  return out ? out : undefined;
}

function fileNameFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const last = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    return /\.[a-z0-9]{2,5}$/i.test(last) ? last : undefined;
  } catch {
    return undefined;
  }
}

function sourceInfo(source: SourceDefinitionBase, id: string) {
  return {
    supplier: source.supplier,
    source: source.key,
    organization_type: source.organizationType,
    canonical_id: id,
    ...(/^https?:\/\//.test(id) ? { canonical_iri: id, source_iri: id } : {}),
  };
}

/** OpenMeeting's ODS status to the ORI event status the other suppliers use. */
function meetingStatus(status: string | undefined): string {
  return status === "geannuleerd" ? "EventCancelled" : "EventConfirmed";
}

/** One published meeting as our entities: the meeting with its agenda, its
 * committee when it names one, and a document entity per distinct document.
 * A document on two agenda items is one entity, as with the other
 * suppliers. */
export async function normalizePublishedMeeting(
  source: SourceDefinitionBase,
  published: PublishedMeeting,
): Promise<{ meeting: MeetingEntity; documents: DocumentEntity[]; committee?: CommitteeEntity }> {
  const meetingId = canonicalMeetingId(source, await openMeetingNativeId(published.id));
  const startDate = new Date(published.start_date).toISOString();
  const endDate = published.end_date ? new Date(published.end_date).toISOString() : undefined;
  const organization = canonicalOrganizationId(source);

  let committee: CommitteeEntity | undefined;
  if (published.committee) {
    const name = trimmed(published.committee_name) ?? trimmed(published.name) ?? "Gremium";
    committee = {
      id: canonicalCommitteeId(source, await openMeetingNativeId(published.committee)),
      type: "Committee",
      name,
      classification:
        /^(gemeente)?raad$/i.test(name) || published.classification?.includes("raad")
          ? ["Council"]
          : ["Committee"],
      subOrganizationOf: organization,
      source_info: sourceInfo(source, published.committee),
      raw: { id: published.committee, name: published.committee_name },
    };
  }

  const itemIds = new Map<string, string>();
  for (const item of published.agenda ?? []) {
    itemIds.set(item.id, canonicalAgendaItemId(source, await openMeetingNativeId(item.id)));
  }

  const documents = new Map<string, DocumentEntity>();
  const agenda: MeetingAgendaItem[] = [];
  for (const [index, item] of (published.agenda ?? []).entries()) {
    const links = [];
    for (const doc of item.documents ?? []) {
      const id = canonicalDocumentId(source, await openMeetingNativeId(doc.id));
      const fileName = trimmed(doc.file_name) ?? fileNameFromUrl(doc.original_url);
      if (!documents.has(id)) {
        documents.set(id, {
          id,
          type: "Document",
          name: doc.name.trim(),
          classification: doc.classification ? ["Document", doc.classification] : ["Document"],
          original_url: doc.original_url,
          identifier_url: doc.original_url,
          file_name: fileName,
          content_type: trimmed(doc.content_type),
          // Without a file the text OpenMeeting sent is all there is to
          // search. With one, the file's own text wins (materializeDocument).
          md_text:
            !doc.original_url && trimmed(doc.description) ? [doc.description!.trim()] : undefined,
          last_discussed_at: startDate,
          is_referenced_by: meetingId,
          organization,
          source_info: sourceInfo(source, doc.id),
          raw: doc,
        });
      }
      links.push({
        id,
        name: doc.name.trim(),
        file_name: fileName,
        original_url: doc.original_url,
      });
    }
    agenda.push({
      id: itemIds.get(item.id)!,
      parent: item.parent ? itemIds.get(item.parent) : undefined,
      title: trimmed(item.title),
      description: trimmed(item.description),
      number: item.number === undefined || item.number === "" ? undefined : String(item.number),
      order: typeof item.order === "number" ? item.order : index + 1,
      classification: trimmed(item.classification),
      is_heading: item.is_heading === true ? true : undefined,
      start_date: startDate,
      documents: links,
    });
  }

  const meeting: MeetingEntity = {
    id: meetingId,
    type: "Meeting",
    name: published.name.trim(),
    classification: ["Agenda"],
    status: meetingStatus(published.status),
    description: trimmed(published.description),
    location: trimmed(published.location),
    start_date: startDate,
    end_date: endDate,
    last_discussed_at: startDate,
    organization,
    committee: committee?.id,
    agenda,
    attachment: [...documents.keys()],
    source_info: sourceInfo(source, published.id),
    raw: published,
  };

  return { meeting, documents: [...documents.values()], committee };
}
