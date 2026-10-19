import type {
  MeetingAgendaItem,
  MeetingEntity,
  MotionEntity,
  MotionVote,
  MotionVoteTally,
} from "../types.ts";

/** Map a supplier's free-text status onto a comparable outcome.
 *
 * Suppliers phrase this differently per municipality ("Motie verworpen",
 * "verworpen", "Verworpen", "Amendement aangehouden"), so match on the
 * distinguishing word rather than the whole string. `status` is kept verbatim
 * alongside this — when in doubt, the original wins. */
export function normalizeMotionResult(status?: string): MotionEntity["result"] | undefined {
  if (!status) {
    return undefined;
  }

  const text = status.toLowerCase();
  // Check "ingetrokken" and "aangehouden" before the aangenomen/verworpen pair:
  // a withdrawn motion is sometimes phrased "ingetrokken, niet aangenomen".
  // Fryslân writes its statuses in Frisian ("Ynlutsen", "Oannommen",
  // "Fersmiten"), which made all 553 of its motions `overig` (#357).
  if (/ingetrokken|ynlutsen/.test(text)) {
    return "ingetrokken";
  }
  if (text.includes("aangehouden")) {
    return "aangehouden";
  }
  // A negated adoption is a rejection. Matching "aangenomen" anywhere in the
  // text turned "Niet aangenomen" into `aangenomen`: 181 rejected motions at
  // Bronckhorst, Waalre and Brabantse Delta, 107 of them beside a tally with
  // a majority against (#357).
  if (/\bniet\s+(aangenomen|aanvaard)/.test(text)) {
    return "verworpen";
  }
  if (/aangenomen|aanvaard|oannommen/.test(text)) {
    return "aangenomen";
  }
  if (/verworpen|afgewezen|fersmiten/.test(text)) {
    return "verworpen";
  }
  return "overig";
}

/** Statuses that are deliberately `overig`: they say how far the follow-up
 * is, or that the vote was tied, not whether the motion was adopted. Counted
 * on 2026-10-15 across 63 sources: "Afgehandeld" (294), "In behandeling"
 * (66), "Afgedaan" (56), "Overgenomen" (27), staking van stemmen in five
 * spellings (#357). */
const KNOWN_OTHER_STATUS =
  /afgehandeld|afgedaan|in behandeling|in uitvoering|aangekondigd|overgenomen|vervallen|niet ingediend|openstaand|staking|staakten|gelijke stemming|stûkjende stimmen/;

/** Whether a status maps onto a result we chose, rather than falling through
 * to `overig` because nobody has seen the spelling yet. A reviewer on #342
 * pointed out that a new spelling, a dialect or a typo ("Aangneomen") was
 * indistinguishable from a deliberate `overig`. The public result stays
 * `overig` either way; the importers log the unmapped ones so a new spelling
 * is noticed and added here. */
export function isMappedMotionStatus(status?: string): boolean {
  if (!status) {
    return true;
  }
  return (
    normalizeMotionResult(status) !== "overig" || KNOWN_OTHER_STATUS.test(status.toLowerCase())
  );
}

/** One log line per unmapped status per run, not per motion. */
export function createUnmappedStatusReporter(sourceKey: string): (status?: string) => void {
  const seen = new Set<string>();
  return (status) => {
    if (!status || isMappedMotionStatus(status) || seen.has(status)) {
      return;
    }
    seen.add(status);
    console.warn(
      JSON.stringify({ level: "warn", event: "motion_status_unmapped", source: sourceKey, status }),
    );
  };
}

export function tallyVotes(votes: MotionVote[]): MotionVoteTally | undefined {
  if (votes.length === 0) {
    return undefined;
  }
  return {
    in_favour: votes.filter((vote) => vote.option === "voor").length,
    against: votes.filter((vote) => vote.option === "tegen").length,
  };
}

/** Pull the party out of an iBabs proposer string.
 *
 * Format: "Passier, C.E. (Charlotte) (Volt)" — the first parenthesis holds the
 * roepnaam, the last one the fractie. */
export function partyFromProposer(proposer: string): string | undefined {
  const matches = [...proposer.matchAll(/\(([^()]*)\)/g)];
  const last = matches.at(-1)?.[1]?.trim();
  return last && last.length > 0 ? last : undefined;
}

export function splitProposers(value?: string): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

const MONTHS: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

/** Parse the date formats iBabs puts in list-entry values.
 *
 * Observed: "Jan 29 2026 12:00AM" (US month abbreviation, always midnight) and
 * plain "29-1-2026". Parsed explicitly rather than via `new Date(...)` so the
 * result doesn't shift with the host timezone. */
export function parseMotionDate(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();

  const usFormat = trimmed.match(/^([A-Za-z]{3})[a-z]*\s+(\d{1,2})\s+(\d{4})/);
  if (usFormat) {
    const month = MONTHS[usFormat[1].toLowerCase()];
    if (month) {
      return `${usFormat[3]}-${month}-${usFormat[2].padStart(2, "0")}T00:00:00Z`;
    }
  }

  const dutchFormat = trimmed.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (dutchFormat) {
    return `${dutchFormat[3]}-${dutchFormat[2].padStart(2, "0")}-${
      dutchFormat[1].padStart(2, "0")
    }T00:00:00Z`;
  }

  const isoFormat = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoFormat) {
    return `${isoFormat[1]}-${isoFormat[2]}-${isoFormat[3]}T00:00:00Z`;
  }

  return undefined;
}

const DUTCH_MONTHS: Record<string, string> = {
  januari: "01",
  februari: "02",
  maart: "03",
  april: "04",
  mei: "05",
  juni: "06",
  juli: "07",
  augustus: "08",
  september: "09",
  oktober: "10",
  november: "11",
  december: "12",
};

/** The first calendar date anywhere in a free-text value.
 *
 * For an agenda field that is not the `<name> <d-m-yyyy>` shape
 * parseAgendaPointReference needs. Griffies fill these by hand and the
 * portal shows Oss's as "Gemeenteraad 2025, donderdag 11 december" (#378),
 * so beside `29-1-2026` and `2026-01-29` this reads `11 december 2025`, and
 * `11 december` with the only year elsewhere in the text. */
export function findDateInText(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const text = value.toLowerCase();
  const pad = (part: string) => part.padStart(2, "0");

  const dutchNumeric = text.match(/\b(\d{1,2})-(\d{1,2})-(\d{4})\b/);
  if (dutchNumeric) {
    return `${dutchNumeric[3]}-${pad(dutchNumeric[2])}-${pad(dutchNumeric[1])}T00:00:00Z`;
  }
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    return `${iso[1]}-${iso[2]}-${iso[3]}T00:00:00Z`;
  }
  const monthNames = Object.keys(DUTCH_MONTHS).join("|");
  const written = text.match(new RegExp(`\\b(\\d{1,2})\\s+(${monthNames})\\b(?:\\s+(\\d{4}))?`));
  if (written) {
    const years = [...text.matchAll(/\b(19|20)\d{2}\b/g)].map((match) => match[0]);
    const year = written[3] ?? (new Set(years).size === 1 ? years[0] : undefined);
    if (year) {
      return `${year}-${DUTCH_MONTHS[written[2]]}-${pad(written[1])}T00:00:00Z`;
    }
  }
  return undefined;
}

export interface AgendaPointReference {
  meetingName: string;
  meetingDate: string;
  itemNumber?: string;
  itemTitle?: string;
}

/** Parse iBabs' `Values["Agendapunt"]` back-reference.
 *
 * Shape: `Gemeenteraad 29-1-2026\n23 Afrondende besluitvorming na debat …`
 * where `\n` is a literal backslash-n in the XML, not a newline — so split on
 * both. This string is the only usable link from a motion to its meeting;
 * `MeetingItem.ListEntries` (the forward link) is empty in every source
 * tested. */
export function parseAgendaPointReference(value?: string): AgendaPointReference | undefined {
  if (!value) {
    return undefined;
  }

  const [head, ...rest] = value.split(/\\n|\n/);
  if (!head) {
    return undefined;
  }

  const headMatch = head.trim().match(/^(.*?)\s+(\d{1,2}-\d{1,2}-\d{4})\s*$/);
  if (!headMatch) {
    return undefined;
  }

  const meetingDate = parseMotionDate(headMatch[2]);
  if (!meetingDate) {
    return undefined;
  }

  const tail = rest.join(" ").trim();
  const tailMatch = tail.match(/^(\d+(?:\.\d+)*)\s+(.*)$/);

  return {
    meetingName: headMatch[1].trim(),
    meetingDate: meetingDate.slice(0, 10),
    itemNumber: tailMatch?.[1],
    itemTitle: (tailMatch?.[2] ?? tail) || undefined,
  };
}

function normalizeForCompare(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Just enough of a meeting to attach a motion to it.
 *
 * Deliberately not the full `MeetingEntity`: the index lives for the whole run
 * while extraction runs with `retainEntities: false` precisely to keep raw
 * payloads and page chunks out of memory. */
export interface IndexedMeeting {
  id: string;
  name: string;
  start_date: string;
  agenda: Array<{ id: string; title?: string; number?: string; order?: number }>;
}

function flattenAgenda(items?: MeetingAgendaItem[]): IndexedMeeting["agenda"] {
  if (!items?.length) {
    return [];
  }
  return items.flatMap((item) => [
    { id: item.id, title: item.title, number: item.number, order: item.order },
    ...flattenAgenda(item.agenda_items),
  ]);
}

/** Meetings from the current run, indexed so motions can be attached to them. */
export class MeetingIndex {
  private readonly byNameAndDate = new Map<string, IndexedMeeting>();
  private readonly byDate = new Map<string, IndexedMeeting[]>();
  private readonly byAgendaItem = new Map<string, IndexedMeeting>();

  add(meeting: MeetingEntity): void {
    const date = meeting.start_date.slice(0, 10);
    const indexed: IndexedMeeting = {
      id: meeting.id,
      name: meeting.name,
      start_date: meeting.start_date,
      agenda: flattenAgenda(meeting.agenda),
    };
    this.byNameAndDate.set(`${normalizeForCompare(meeting.name)}|${date}`, indexed);
    const sameDay = this.byDate.get(date);
    if (sameDay) {
      sameDay.push(indexed);
    } else {
      this.byDate.set(date, [indexed]);
    }
    for (const item of indexed.agenda) {
      this.byAgendaItem.set(item.id, indexed);
    }
  }

  /** Which meeting an agenda item belongs to.
   *
   * Notubiz module items reference their agenda item by id directly, so this
   * gives an exact link where iBabs only offers a free-text back-reference. */
  findByAgendaItem(agendaItemId: string): IndexedMeeting | undefined {
    return this.byAgendaItem.get(agendaItemId);
  }

  /** Do we already know about any meeting on this day (YYYY-MM-DD)? */
  hasDate(date: string): boolean {
    return this.byDate.has(date);
  }

  find(reference: AgendaPointReference): IndexedMeeting | undefined {
    const exact = this.byNameAndDate.get(
      `${normalizeForCompare(reference.meetingName)}|${reference.meetingDate}`,
    );
    if (exact) {
      return exact;
    }

    // Meeting-type labels drift between the registry ("Gemeenteraad") and the
    // meeting itself ("Gemeenteraad (openbaar)"), so fall back to a prefix
    // match within the same day.
    const sameDay = this.byDate.get(reference.meetingDate) ?? [];
    const wanted = normalizeForCompare(reference.meetingName);
    const prefixMatch = sameDay.find((meeting) => {
      const name = normalizeForCompare(meeting.name);
      return name.startsWith(wanted) || wanted.startsWith(name);
    });
    if (prefixMatch) {
      return prefixMatch;
    }

    return sameDay.length === 1 ? sameDay[0] : undefined;
  }
}

/** Resolve the agenda item a motion was decided in, within a known meeting. */
export function findAgendaItemId(
  meeting: IndexedMeeting,
  reference: AgendaPointReference,
): string | undefined {
  const items = meeting.agenda;
  if (items.length === 0) {
    return undefined;
  }

  if (reference.itemTitle) {
    const wanted = normalizeForCompare(reference.itemTitle);
    const titleMatch = items.find((item) => {
      if (!item.title) {
        return false;
      }
      const title = normalizeForCompare(item.title);
      return title === wanted || title.startsWith(wanted) || wanted.startsWith(title);
    });
    if (titleMatch) {
      return titleMatch.id;
    }
  }

  if (reference.itemNumber) {
    const numberMatch = items.find((item) =>
      item.number === reference.itemNumber ||
      String(item.order ?? "") === reference.itemNumber
    );
    if (numberMatch) {
      return numberMatch.id;
    }
  }

  return undefined;
}
