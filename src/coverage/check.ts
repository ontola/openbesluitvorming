/**
 * Coverage check: does the search index hold what the supplier publishes?
 *
 * For one source and one date window, list every document id the supplier's
 * own API exposes -- meeting documents, and the attachments of register and
 * motion entries -- and compare that set with the document ids the export log
 * holds for the source. What the supplier lists and we lack is the gap; it is
 * counted and sampled, and the result is stored so `/api/status` can show it
 * next to "last import succeeded".
 *
 * The comparison is by canonical document id, the same id the importers
 * build, so a supplier count here means exactly what an import would have
 * produced. It reuses the clients and the pure normalisers and downloads
 * nothing.
 *
 * This is the application control asked for in #258: until now the status
 * page could only say that the last import ran without errors, which is true
 * of a run that structurally never asks for half the documents (#226, #258).
 */
import { GemeenteOplossingenClient } from "../gemeenteoplossingen/client.ts";
import { normalizeGoDocuments, normalizeGoMeeting } from "../gemeenteoplossingen/normalize.ts";
import { IbabsClient } from "../ibabs/client.ts";
import {
  normalizeIbabsDocuments,
  normalizeIbabsMeeting,
  normalizeIbabsMotion,
  normalizeIbabsMotionDocuments,
  normalizeIbabsRegisterDocuments,
} from "../ibabs/normalize.ts";
import { NotubizClient } from "../notubiz/client.ts";
import {
  isMotionModule,
  isRegisterModule,
  normalizeNotubizMotion,
  normalizeNotubizMotionDocuments,
  normalizeNotubizRegisterDocuments,
} from "../notubiz/motions.ts";
import { normalizeNotubizDocuments, normalizeNotubizMeeting } from "../notubiz/normalize.ts";
import { ParlaeusClient } from "../parlaeus/client.ts";
import { normalizeParlaeusAgenda } from "../parlaeus/normalize.ts";
import type {
  GemeenteOplossingenSourceDefinition,
  IbabsSourceDefinition,
  NotubizModuleItem,
  NotubizSourceDefinition,
  ParlaeusSourceDefinition,
  SourceDefinition,
} from "../types.ts";
import { mapLimit } from "../util/map_limit.ts";

export interface SupplierDocumentListing {
  /** Canonical document ids the supplier exposes in the window. */
  documentIds: Set<string>;
  meetings: number;
  /** Register/motion entries whose attachments were listed. */
  registerEntries: number;
  /** Requests that failed; the listing is then a lower bound. */
  warnings: string[];
}

export interface CoverageComparison {
  supplierDocuments: number;
  heldDocuments: number;
  /** Supplier documents absent from the export log. */
  missingDocuments: number;
  /** Up to `sampleSize` missing ids, for a human to look at. */
  missingSample: string[];
}

/** The pure part: what the supplier lists minus what we hold. Held documents
 * outside the supplier's listing (older, or from a register the supplier no
 * longer shows) are not a gap and are not counted against anyone. */
export function compareCoverage(
  supplierIds: Iterable<string>,
  heldIds: Iterable<string>,
  sampleSize = 25,
): CoverageComparison {
  const held = heldIds instanceof Set ? heldIds : new Set(heldIds);
  const supplier = supplierIds instanceof Set ? supplierIds : new Set(supplierIds);
  const missing: string[] = [];
  let heldInWindow = 0;
  for (const id of supplier) {
    if (held.has(id)) {
      heldInWindow += 1;
    } else {
      missing.push(id);
    }
  }
  missing.sort();
  return {
    supplierDocuments: supplier.size,
    heldDocuments: heldInWindow,
    missingDocuments: missing.length,
    missingSample: missing.slice(0, sampleSize),
  };
}

const NOTUBIZ_MEETING_CONCURRENCY = 4;

async function listNotubiz(
  source: NotubizSourceDefinition,
  dateFrom: string,
  dateTo: string,
  client = new NotubizClient(),
): Promise<SupplierDocumentListing> {
  const listing: SupplierDocumentListing = {
    documentIds: new Set(),
    meetings: 0,
    registerEntries: 0,
    warnings: [],
  };
  const attributes = await client.getOrganizationAttributes(source.notubizOrganizationId);

  const meetingIds: number[] = [];
  for (let page = 1; ; page += 1) {
    const response = (await client.listEvents(
      source.notubizOrganizationId,
      dateFrom,
      dateTo,
      page,
    )) as { events?: unknown[]; pagination?: { has_more_pages?: boolean } };
    const events = Array.isArray(response.events) ? response.events : [];
    if (events.length === 0) {
      break;
    }
    for (const event of events) {
      const record = event as { id?: unknown; permission_group?: unknown };
      if (record.permission_group === "public" && typeof record.id === "number") {
        meetingIds.push(record.id);
      }
    }
    if (!response.pagination?.has_more_pages) {
      break;
    }
  }

  await mapLimit(meetingIds, NOTUBIZ_MEETING_CONCURRENCY, async (meetingId) => {
    try {
      const response = (await client.getMeeting(meetingId)) as { meeting?: unknown };
      if (!response.meeting) {
        listing.warnings.push(`meeting ${meetingId}: no detail`);
        return;
      }
      const meeting = normalizeNotubizMeeting(source, attributes, response.meeting);
      listing.meetings += 1;
      for (const document of normalizeNotubizDocuments(source, meeting)) {
        listing.documentIds.add(document.id);
      }
    } catch (error) {
      listing.warnings.push(`meeting ${meetingId}: ${errorText(error)}`);
    }
  });

  let modules;
  try {
    modules = await client.listModules(source.notubizOrganizationId);
  } catch (error) {
    listing.warnings.push(`modules: ${errorText(error)}`);
    return listing;
  }
  for (const module of modules) {
    if (!isMotionModule(module) && !isRegisterModule(module)) {
      continue;
    }
    let items: NotubizModuleItem[];
    try {
      items = await client.listModuleItems(
        source.notubizOrganizationId,
        module.id,
        dateFrom,
        dateTo,
      );
    } catch (error) {
      listing.warnings.push(`module ${module.name}: ${errorText(error)}`);
      continue;
    }
    for (const item of items) {
      if (item.permission_group && item.permission_group !== "public") {
        continue;
      }
      listing.registerEntries += 1;
      const documents = isMotionModule(module)
        ? normalizeNotubizMotionDocuments(
            source,
            normalizeNotubizMotion(source, module, item),
            item,
          )
        : normalizeNotubizRegisterDocuments(source, module, item);
      for (const document of documents) {
        listing.documentIds.add(document.id);
      }
    }
  }
  return listing;
}

const IBABS_ENTRY_CONCURRENCY = 2;

async function listIbabs(
  source: IbabsSourceDefinition,
  dateFrom: string,
  dateTo: string,
  client = new IbabsClient(),
): Promise<SupplierDocumentListing> {
  const listing: SupplierDocumentListing = {
    documentIds: new Set(),
    meetings: 0,
    registerEntries: 0,
    warnings: [],
  };
  const meetingTypes = new Map<string, string>();
  try {
    for (const meetingType of await client.getMeetingTypes(source)) {
      meetingTypes.set(
        meetingType.Id,
        meetingType.Description ?? meetingType.Meetingtype ?? meetingType.Id,
      );
    }
  } catch (error) {
    listing.warnings.push(`meeting types: ${errorText(error)}`);
  }

  for (const rawMeeting of await client.listMeetingsByDateRange(source, dateFrom, dateTo)) {
    try {
      const meeting = normalizeIbabsMeeting(source, rawMeeting, meetingTypes);
      listing.meetings += 1;
      for (const document of normalizeIbabsDocuments(source, meeting)) {
        listing.documentIds.add(document.id);
      }
    } catch (error) {
      listing.warnings.push(`meeting: ${errorText(error)}`);
    }
  }

  let lists;
  try {
    lists = await client.getLists(source);
  } catch (error) {
    listing.warnings.push(`lists: ${errorText(error)}`);
    return listing;
  }
  const motionPattern = /moties?|amendement|stemming/i;
  for (const list of lists) {
    if (!list.ListName?.trim()) {
      continue;
    }
    let entries;
    try {
      entries = await client.listListEntries(source, list.ListId, dateFrom);
    } catch (error) {
      listing.warnings.push(`list ${list.ListName}: ${errorText(error)}`);
      continue;
    }
    const inWindow = entries.filter(
      (entry) => !entry.MutationDate || entry.MutationDate.slice(0, 10) <= dateTo,
    );
    await mapLimit(inWindow, IBABS_ENTRY_CONCURRENCY, async (entry) => {
      try {
        const detail = await client.getListEntry(source, list.ListId, entry.EntryId);
        listing.registerEntries += 1;
        const documents = motionPattern.test(list.ListName)
          ? normalizeIbabsMotionDocuments(
              source,
              normalizeIbabsMotion(source, list, entry, detail, []),
              detail,
            )
          : normalizeIbabsRegisterDocuments(source, list, entry, detail);
        for (const document of documents) {
          listing.documentIds.add(document.id);
        }
      } catch (error) {
        listing.warnings.push(`entry ${entry.EntryId}: ${errorText(error)}`);
      }
    });
  }
  return listing;
}

async function listGemeenteOplossingen(
  source: GemeenteOplossingenSourceDefinition,
  dateFrom: string,
  dateTo: string,
  client = new GemeenteOplossingenClient(source.baseUrl, source.apiVersion ?? "v1"),
): Promise<SupplierDocumentListing> {
  const listing: SupplierDocumentListing = {
    documentIds: new Set(),
    meetings: 0,
    registerEntries: 0,
    warnings: [],
  };
  for (const rawMeeting of await client.listMeetingsByDateRange(dateFrom, dateTo)) {
    try {
      const meeting = normalizeGoMeeting(source, rawMeeting);
      listing.meetings += 1;
      for (const document of normalizeGoDocuments(source, meeting)) {
        listing.documentIds.add(document.id);
      }
    } catch (error) {
      listing.warnings.push(`meeting: ${errorText(error)}`);
    }
  }
  return listing;
}

const PARLAEUS_AGENDA_CONCURRENCY = 2;

async function listParlaeus(
  source: ParlaeusSourceDefinition,
  dateFrom: string,
  dateTo: string,
  client = new ParlaeusClient(source.baseUrl, source.sessionId),
): Promise<SupplierDocumentListing> {
  const listing: SupplierDocumentListing = {
    documentIds: new Set(),
    meetings: 0,
    registerEntries: 0,
    warnings: [],
  };
  const summaries = await client.listAgendaSummaries(dateFrom, dateTo);
  await mapLimit(summaries, PARLAEUS_AGENDA_CONCURRENCY, async (summary) => {
    try {
      const { detail } = await client.getAgendaDetail(summary.agid);
      const { documents } = normalizeParlaeusAgenda(source, detail);
      listing.meetings += 1;
      for (const document of documents) {
        listing.documentIds.add(document.id);
      }
    } catch (error) {
      listing.warnings.push(`agenda ${summary.agid}: ${errorText(error)}`);
    }
  });
  return listing;
}

/** List what the supplier exposes for the source in the window. */
export function listSupplierDocuments(
  source: SourceDefinition,
  dateFrom: string,
  dateTo: string,
): Promise<SupplierDocumentListing> {
  switch (source.supplier) {
    case "notubiz":
      return listNotubiz(source as NotubizSourceDefinition, dateFrom, dateTo);
    case "ibabs":
      return listIbabs(source as IbabsSourceDefinition, dateFrom, dateTo);
    case "gemeenteoplossingen":
      return listGemeenteOplossingen(
        source as GemeenteOplossingenSourceDefinition,
        dateFrom,
        dateTo,
      );
    case "parlaeus":
      return listParlaeus(source as ParlaeusSourceDefinition, dateFrom, dateTo);
    default:
      return Promise.reject(
        new Error(`No coverage listing for supplier ${(source as SourceDefinition).supplier}`),
      );
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const __test__ = { listNotubiz, listIbabs, listGemeenteOplossingen, listParlaeus };
