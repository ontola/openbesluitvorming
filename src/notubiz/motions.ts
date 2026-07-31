import {
  canonicalAgendaItemId,
  canonicalDocumentId,
  canonicalMotionId,
  canonicalOrganizationId,
} from "../ids.ts";
import {
  type MeetingIndex,
  normalizeMotionResult,
  parseMotionDate,
} from "../motions/normalize.ts";
import type {
  DocumentEntity,
  MotionEntity,
  NotubizModule,
  NotubizModuleItem,
  NotubizModuleItemAttribute,
  NotubizSourceDefinition,
} from "../types.ts";

/** Notubiz module-item field ids.
 *
 * Municipalities rename the *labels* freely ("Uitslag", "Stemming", "Status",
 * "uitslag" all appear for the same field) but the numeric ids are stable
 * across organisations, so map on the id and treat the label as a hint. */
const FIELD = {
  title: 1,
  mainDocument: 2,
  date: 15,
  answerDate: 17,
  linkedEvent: 22,
  caseCode: 24,
  explanation: 35,
  initiator: 36,
  parties: 37,
  type: 45,
  agendaItem: 54,
  remarks: 61,
  outcome: 62,
  status: 71,
  coSigners: 87,
} as const;

/** Notubiz's own module name for the moties registry. `custom_name` is the
 * municipality's rename of it and is often something else entirely. */
const MOTION_MODULE_PATTERN = /^moties$|^amendementen$/i;

export function isMotionModule(module: NotubizModule): boolean {
  return MOTION_MODULE_PATTERN.test(module.name?.trim() ?? "");
}

function attributesById(item: NotubizModuleItem): Map<number, NotubizModuleItemAttribute> {
  const map = new Map<number, NotubizModuleItemAttribute>();
  for (const attribute of item.attributes ?? []) {
    map.set(attribute.id, attribute);
  }
  return map;
}

function textOf(attribute?: NotubizModuleItemAttribute): string | undefined {
  const content = attribute?.values?.[0]?.content;
  if (typeof content === "string" && content.trim().length > 0) {
    return content.trim();
  }
  if (typeof content === "number") {
    return String(content);
  }
  return undefined;
}

function labelsOf(attribute?: NotubizModuleItemAttribute): string[] {
  return (attribute?.values ?? [])
    .map((value) => value.meta_data?.label?.trim())
    .filter((label): label is string => Boolean(label));
}

function referenceIds(
  attribute: NotubizModuleItemAttribute | undefined,
  referenceModel: string,
): string[] {
  return (attribute?.values ?? [])
    .filter((value) => value.meta_data?.reference_model === referenceModel)
    .map((value) => (value.content === null || value.content === undefined
      ? undefined
      : String(value.content)))
    .filter((id): id is string => Boolean(id));
}

/** Turn the supplier's HTML vote breakdown into plain text.
 *
 * Stored as published rather than parsed into counts — the phrasing differs
 * per municipality ("Stemmen voor: 23 CDA, AL, SGP…", "Stemmen voor: 27 -
 * overige fracties") and a misread vote count is worse than an unparsed
 * sentence. Tags are stripped because this ends up in the web UI, where
 * rendering supplier HTML would be an injection risk. */
export function htmlToText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/** Pick the outcome field.
 *
 * Field 62 holds it in 17 of 18 sampled organisations, but a few put it in 71
 * and some leave 62 holding prose ("gelijke stemming - wordt opnieuw in
 * stemming gebracht"). Prefer whichever candidate maps onto a real outcome,
 * and fall back to field 62 verbatim so nothing is silently dropped. */
function pickStatus(attributes: Map<number, NotubizModuleItemAttribute>): string | undefined {
  const candidates = [textOf(attributes.get(FIELD.outcome)), textOf(attributes.get(FIELD.status))]
    .filter((value): value is string => Boolean(value));

  const decisive = candidates.find((value) => normalizeMotionResult(value) !== "overig");
  return decisive ?? candidates[0];
}

/** Find a free-text vote breakdown.
 *
 * Field 61 is "Opmerkingen" in most organisations but "Stemmingsuitslag" or
 * "Uitslag stemming" in others, so the label decides. A value that maps onto a
 * plain outcome is the outcome field, not a breakdown. */
function pickVoteSummary(attributes: Map<number, NotubizModuleItemAttribute>): string | undefined {
  for (const attribute of attributes.values()) {
    if (!/stem/i.test(attribute.label ?? "")) {
      continue;
    }
    const value = textOf(attribute);
    if (!value || normalizeMotionResult(value) !== "overig") {
      continue;
    }
    const text = htmlToText(value);
    if (text.length > 0) {
      return text;
    }
  }
  return undefined;
}

export function normalizeNotubizMotion(
  source: NotubizSourceDefinition,
  module: NotubizModule,
  item: NotubizModuleItem,
  meetings?: MeetingIndex,
): MotionEntity {
  const attributes = attributesById(item);
  const name = textOf(attributes.get(FIELD.title)) ?? `${module.name} ${item.id}`;
  const status = pickStatus(attributes);
  const motionType = textOf(attributes.get(FIELD.type)) ?? module.name;

  // Notubiz references the agenda item by id, so the link is exact — no need
  // for the free-text matching iBabs forces on us.
  const agendaItemIds = [
    ...referenceIds(attributes.get(FIELD.agendaItem), "agenda_item"),
    ...referenceIds(attributes.get(FIELD.linkedEvent), "agenda_item"),
  ].map((id) => canonicalAgendaItemId(source, id));

  let agendaItem: string | undefined;
  let meeting: string | undefined;
  let meetingStart: string | undefined;
  for (const candidate of agendaItemIds) {
    const owner = meetings?.findByAgendaItem(candidate);
    if (owner) {
      agendaItem = candidate;
      meeting = owner.id;
      meetingStart = owner.start_date;
      break;
    }
  }
  // A motion can be submitted in one meeting and re-tabled in another; when we
  // can't place any of them, keep the first reference so the link survives.
  agendaItem ??= agendaItemIds[0];

  const parties = labelsOf(attributes.get(FIELD.parties));
  const proposers = labelsOf(attributes.get(FIELD.initiator));
  const coProposers = labelsOf(attributes.get(FIELD.coSigners));
  const date = parseMotionDate(textOf(attributes.get(FIELD.date)));

  const documentIds = referenceIds(attributes.get(FIELD.mainDocument), "document")
    .map((id) => canonicalDocumentId(source, id));

  return {
    id: canonicalMotionId(source, item.id),
    type: "Motion",
    name,
    classification: [module.name],
    motion_type: motionType,
    status,
    result: normalizeMotionResult(status),
    date,
    description: textOf(attributes.get(FIELD.explanation)),
    proposers: proposers.length > 0 ? proposers : undefined,
    co_proposers: coProposers.length > 0 ? coProposers : undefined,
    parties: parties.length > 0 ? parties : undefined,
    // Notubiz publishes no per-member breakdown; where a municipality records
    // one it is prose in a text field, carried in vote_summary instead.
    vote_summary: pickVoteSummary(attributes),
    meeting,
    agenda_item: agendaItem,
    agenda_item_hint: meeting
      ? undefined
      : labelsOf(attributes.get(FIELD.agendaItem))[0] ??
        labelsOf(attributes.get(FIELD.linkedEvent))[0],
    attachment: documentIds.length > 0 ? documentIds : undefined,
    organization: canonicalOrganizationId(source),
    last_discussed_at: meetingStart ?? date,
    source_info: {
      supplier: source.supplier,
      source: source.key,
      organization_type: source.organizationType,
      canonical_id: String(item.id),
      canonical_iri: `https://api.notubiz.nl/modules/${module.id}/items/${item.id}`,
    },
    raw: item,
  };
}

/** Documents attached to a Notubiz motion.
 *
 * Only the main document (field 2) is materialized. `attachments.document`
 * also carries bijlagen, but those are already reachable through the agenda
 * item and would double the download load for little gain. */
export function normalizeNotubizMotionDocuments(
  source: NotubizSourceDefinition,
  motion: MotionEntity,
  item: NotubizModuleItem,
): DocumentEntity[] {
  const attributes = attributesById(item);
  const main = attributes.get(FIELD.mainDocument);

  return (main?.values ?? [])
    .filter((value) => value.meta_data?.reference_model === "document")
    .map((value) => String(value.content))
    .filter((id) => id && id !== "null" && id !== "undefined")
    .map((documentId) => ({
      id: canonicalDocumentId(source, documentId),
      type: "Document" as const,
      name: motion.name,
      classification: [motion.motion_type ?? "Motie"],
      original_url: `https://api.notubiz.nl/document/${documentId}/1`,
      identifier_url: `https://api.notubiz.nl/document/${documentId}`,
      last_discussed_at: motion.last_discussed_at,
      is_referenced_by: motion.id,
      organization: motion.organization,
      source_info: {
        supplier: source.supplier,
        source: source.key,
        organization_type: source.organizationType,
        canonical_id: documentId,
        canonical_iri: `https://api.notubiz.nl/document/${documentId}`,
        source_iri: motion.source_info.canonical_iri,
      },
      raw: { id: documentId, motion: motion.id },
    }));
}

export const __test__ = { FIELD, pickStatus, pickVoteSummary, attributesById };
