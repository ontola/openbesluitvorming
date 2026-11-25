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
import type { OdsAgendapunt, OdsInformatieobject, OdsVergadering } from "./feed.ts";
import type { MirrorIndex } from "./mirror.ts";

/** A bronidentificatie we can use as is in our own ids. Anything else (an
 * Atomic subject URL, a `did:`, spaces) becomes a short stable hash, and the
 * original stays in `source_info.canonical_id`. */
const SAFE_NATIVE_ID = /^[A-Za-z0-9._~-]{1,100}$/;

export async function odsNativeId(bronidentificatie: string): Promise<string> {
  if (SAFE_NATIVE_ID.test(bronidentificatie)) return bronidentificatie;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bronidentificatie));
  return [...new Uint8Array(digest).slice(0, 10)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Whether the worker may download [value]: https on a public host name.
 * The worker fetches every `bestandsurl`, from inside our network, so an
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

/** When a vergadering is: what happened, else what was planned. A bare date
 * is taken as midnight in Amsterdam. */
export function vergaderingStart(vergadering: OdsVergadering): string | undefined {
  const instant = vergadering.aanvang ?? vergadering.geplandeaanvang;
  if (instant && !Number.isNaN(Date.parse(instant))) return new Date(instant).toISOString();
  const day = vergadering.vergaderdatum ?? vergadering.geplandedatum;
  if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return new Date(`${day}T00:00:00+01:00`).toISOString();
  }
  return undefined;
}

/** The Europe/Amsterdam calendar day of an instant: the day a meeting is on,
 * which is what an import window (`YYYY-MM-DD` to `YYYY-MM-DD`) means. */
export function amsterdamDay(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Amsterdam",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function trimmed(value: string | undefined | null): string | undefined {
  const out = typeof value === "string" ? value.trim() : undefined;
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

function sourceInfo(source: SourceDefinitionBase, bronidentificatie: string, url?: string) {
  return {
    supplier: source.supplier,
    source: source.key,
    organization_type: source.organizationType,
    canonical_id: bronidentificatie,
    ...(url ? { canonical_iri: url, source_iri: url } : {}),
  };
}

/** ODS vergaderstatus to the ORI event status the other suppliers use. */
function meetingStatus(status: string | undefined): string {
  return status?.toLowerCase() === "geannuleerd" ? "EventCancelled" : "EventConfirmed";
}

/** Sort key of a volgnummer: "2", "2a", "10" in that order. */
function orderKey(item: OdsAgendapunt): [number, string] {
  const raw = item.volgnummer ?? item.geplandvolgnummer ?? "";
  const match = /^(\d+)(.*)$/.exec(raw.trim());
  return match ? [Number(match[1]), match[2]] : [Number.MAX_SAFE_INTEGER, raw];
}

/** The agendapunten of a vergadering: the ones it lists and the ones that
 * point at it, in agenda order. */
function agendapuntenOf(vergadering: OdsVergadering, index: MirrorIndex): OdsAgendapunt[] {
  const items = new Map<string, OdsAgendapunt>();
  for (const ref of vergadering.agendapunten ?? []) {
    const item = index.agendapunten.get(ref.bronidentificatie);
    if (item) items.set(item.bronidentificatie, item);
  }
  for (const item of index.agendapunten.values()) {
    if (item.vergadering?.bronidentificatie === vergadering.bronidentificatie) {
      items.set(item.bronidentificatie, item);
    }
  }
  const listed = (vergadering.agendapunten ?? []).map((ref) => ref.bronidentificatie);
  return [...items.values()].sort((left, right) => {
    const [ln, ls] = orderKey(left);
    const [rn, rs] = orderKey(right);
    if (ln !== rn) return ln - rn;
    if (ls !== rs) return ls.localeCompare(rs, "nl");
    return listed.indexOf(left.bronidentificatie) - listed.indexOf(right.bronidentificatie);
  });
}

/** Which informatieobjecten hang at which agendapunt, and which at the
 * vergadering itself. */
function informatieobjectenOf(
  vergadering: OdsVergadering,
  items: OdsAgendapunt[],
  index: MirrorIndex,
): { byItem: Map<string, OdsInformatieobject[]>; onMeeting: OdsInformatieobject[] } {
  const itemIds = new Set(items.map((item) => item.bronidentificatie));
  const byItem = new Map<string, OdsInformatieobject[]>();
  const onMeeting: OdsInformatieobject[] = [];
  for (const doc of index.informatieobjecten.values()) {
    let onItem = false;
    for (const ref of doc.agendapunten ?? []) {
      if (!itemIds.has(ref.bronidentificatie)) continue;
      onItem = true;
      const list = byItem.get(ref.bronidentificatie) ?? [];
      list.push(doc);
      byItem.set(ref.bronidentificatie, list);
    }
    if (
      !onItem &&
      (doc.vergaderingen ?? []).some(
        (ref) => ref.bronidentificatie === vergadering.bronidentificatie,
      )
    ) {
      onMeeting.push(doc);
    }
  }
  return { byItem, onMeeting };
}

/** One vergadering from the feed as our entities: the meeting with its
 * agenda, its committee when it names a gremium, and a document entity per
 * distinct informatieobject. A document on two agendapunten is one entity,
 * as with the other suppliers. */
export async function normalizeOdsMeeting(
  source: SourceDefinitionBase,
  vergadering: OdsVergadering,
  index: MirrorIndex,
): Promise<{ meeting: MeetingEntity; documents: DocumentEntity[]; committee?: CommitteeEntity }> {
  const startDate = vergaderingStart(vergadering);
  if (!startDate) {
    throw new Error(`Vergadering ${vergadering.bronidentificatie} has no aanvang or datum`);
  }
  const meetingId = canonicalMeetingId(source, await odsNativeId(vergadering.bronidentificatie));
  const endInstant = vergadering.einde ?? vergadering.geplandeeinde;
  const endDate =
    endInstant && !Number.isNaN(Date.parse(endInstant))
      ? new Date(endInstant).toISOString()
      : undefined;
  const organization = canonicalOrganizationId(source);

  let committee: CommitteeEntity | undefined;
  const gremium = vergadering.georganiseerddoorgremium;
  if (gremium?.gremiumidentificatie) {
    const name = trimmed(gremium.gremiumnaam) ?? "Gremium";
    committee = {
      id: canonicalCommitteeId(source, await odsNativeId(gremium.gremiumidentificatie)),
      type: "Committee",
      name,
      classification: /^(gemeente)?raad$|^provinciale staten$|^algemeen bestuur$/i.test(name)
        ? ["Council"]
        : ["Committee"],
      subOrganizationOf: organization,
      source_info: sourceInfo(source, gremium.gremiumidentificatie),
      raw: gremium,
    };
  }

  const items = agendapuntenOf(vergadering, index);
  const itemIds = new Map<string, string>();
  for (const item of items) {
    itemIds.set(
      item.bronidentificatie,
      canonicalAgendaItemId(source, await odsNativeId(item.bronidentificatie)),
    );
  }
  const { byItem, onMeeting } = informatieobjectenOf(vergadering, items, index);

  const documents = new Map<string, DocumentEntity>();
  const documentEntity = async (doc: OdsInformatieobject) => {
    const id = canonicalDocumentId(source, await odsNativeId(doc.bronidentificatie));
    const bestandsurl = trimmed(doc.bestandsurl);
    const fileName = fileNameFromUrl(bestandsurl);
    if (!documents.has(id)) {
      documents.set(id, {
        id,
        type: "Document",
        name: doc.titel.trim(),
        classification: doc.informatieobjecttype
          ? ["Document", doc.informatieobjecttype]
          : ["Document"],
        original_url: bestandsurl,
        identifier_url: trimmed(doc.webpaginalink) ?? bestandsurl,
        file_name: fileName,
        content_type: trimmed(doc.formaat),
        size_in_bytes: typeof doc.omvang === "number" ? doc.omvang : undefined,
        // Without a file the omschrijving is all there is to search. With one,
        // the file's own text wins (materializeDocument).
        md_text: !bestandsurl && trimmed(doc.omschrijving) ? [doc.omschrijving!.trim()] : undefined,
        last_discussed_at: startDate,
        is_referenced_by: meetingId,
        organization,
        source_info: sourceInfo(source, doc.bronidentificatie, doc.url),
        raw: doc,
      });
    }
    return { id, name: doc.titel.trim(), file_name: fileName, original_url: bestandsurl };
  };

  const agenda: MeetingAgendaItem[] = [];
  for (const [position, item] of items.entries()) {
    const links = [];
    for (const doc of byItem.get(item.bronidentificatie) ?? []) {
      links.push(await documentEntity(doc));
    }
    const itemStart = item.starttijd ?? item.geplandestarttijd;
    agenda.push({
      id: itemIds.get(item.bronidentificatie)!,
      parent: item.hoofdagendapunt
        ? itemIds.get(item.hoofdagendapunt.bronidentificatie)
        : undefined,
      title: trimmed(item.agendapuntnaam),
      description: trimmed(item.omschrijving),
      number: trimmed(item.volgnummer ?? item.geplandvolgnummer),
      order: position + 1,
      classification: item.indicatiehamerstuk === true ? "hamerstuk" : undefined,
      start_date:
        itemStart && !Number.isNaN(Date.parse(itemStart))
          ? new Date(itemStart).toISOString()
          : startDate,
      documents: links,
    });
  }
  for (const doc of onMeeting) await documentEntity(doc);

  const meeting: MeetingEntity = {
    id: meetingId,
    type: "Meeting",
    name: vergadering.naam.trim(),
    classification: ["Agenda"],
    status: meetingStatus(vergadering.vergaderstatus),
    description: trimmed(vergadering.vergadertoelichting),
    location: trimmed(vergadering.locatie),
    start_date: startDate,
    end_date: endDate,
    last_discussed_at: startDate,
    organization,
    committee: committee?.id,
    agenda,
    attachment: [...documents.keys()],
    source_info: sourceInfo(source, vergadering.bronidentificatie, vergadering.url),
    raw: vergadering,
  };

  return { meeting, documents: [...documents.values()], committee };
}

/** What is wrong with a resource for us to import it, in English for the run
 * log. Empty when it can be used. The feed is someone else's: a bad record
 * is skipped with an issue, it never stops the import. */
export function odsDocumentProblems(doc: OdsInformatieobject): string[] {
  const problems: string[] = [];
  if (!trimmed(doc.titel)) problems.push("informatieobject has no titel");
  if (doc.bestandsurl && !isPublicHttpsUrl(doc.bestandsurl)) {
    problems.push(`bestandsurl is not a public https address (${doc.bestandsurl})`);
  }
  return problems;
}
