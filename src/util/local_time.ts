/**
 * Supplier timestamps are Dutch wall-clock readings, and most feeds send them
 * without any zone at all: iBabs emits `2026-08-19T19:30:00`, GO composes
 * `date` + `startTime`, Parlaeus composes `date` + `time`, and Notubiz is
 * inconsistent — some organisations send `+01:00`, others a bare
 * `2026-08-19 19:30:00`.
 *
 * Those bare readings used to be stamped `Z`, which claims a 19:30 council
 * meeting starts at 19:30 UTC. The whole system was internally consistent
 * about it — search rendered the result back in UTC, so the *date* looked
 * right — but every consumer reading `sortDate` as a real instant saw the
 * meeting one or two hours late, depending on the season. That is #203.
 *
 * So: a reading that carries an offset is trusted and normalised; a bare
 * reading is interpreted in Europe/Amsterdam, which is the zone every one of
 * these suppliers publishes in.
 */

const SUPPLIER_TIME_ZONE = "Europe/Amsterdam";
const MINUTE_MS = 60_000;
const CET_OFFSET_MINUTES = 60;

/** Wall clock with a real time, `T` or space separated, seconds optional. */
const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const DATE_ONLY = /^(\d{4}-\d{2}-\d{2})$/;
const HAS_EXPLICIT_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/** Offset of Europe/Amsterdam at `instantMs`, in minutes east of UTC. */
function amsterdamOffsetMinutes(instantMs: number): number {
  const zoneName = new Intl.DateTimeFormat("en-US", {
    timeZone: SUPPLIER_TIME_ZONE,
    timeZoneName: "longOffset",
  })
    .formatToParts(new Date(instantMs))
    .find((part) => part.type === "timeZoneName")?.value;

  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(zoneName ?? "");
  if (!match) {
    // Same fallback the scheduler takes: standard time, rather than throwing
    // away a timestamp because Intl gave an unexpected shape.
    return CET_OFFSET_MINUTES;
  }

  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

function toSecondPrecisionUtc(instantMs: number): string {
  return `${new Date(instantMs).toISOString().slice(0, 19)}Z`;
}

/** Whether the components name a day that exists.
 *
 * `Date.UTC` rolls over silently, so month 00 or day 32 would otherwise be
 * accepted and answered with a confidently wrong instant. Suppliers do emit
 * `0000-00-00`.
 */
function isRealDate(year: number, month: number, day: number): boolean {
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/** Interpret a Dutch wall-clock reading as an instant.
 *
 * The offset has to be looked up twice. The first lookup uses the reading as
 * if it were already UTC, which is up to an hour off, and that is enough to
 * land on the wrong side of a DST switch for readings within an hour of it.
 * The second lookup uses the corrected instant and wins.
 */
function amsterdamWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes: number,
  seconds: number,
): number {
  const asIfUtc = Date.UTC(year, month - 1, day, hours, minutes, seconds);
  const firstGuess = asIfUtc - amsterdamOffsetMinutes(asIfUtc) * MINUTE_MS;
  return asIfUtc - amsterdamOffsetMinutes(firstGuess) * MINUTE_MS;
}

/** Normalise a supplier timestamp to an RFC3339 instant in UTC.
 *
 * Returns `undefined` for anything unrecognisable, so a caller can keep its
 * own fallback rather than propagate a value this function invented.
 *
 * A date without a time, and a time of exactly midnight, stay midnight UTC.
 * Those are dates rather than moments — a document's publication day, or GO's
 * `T00:00:00` filler for a meeting whose start time is unknown — and shifting
 * them into the previous evening would move them to the previous *day* for
 * every consumer that reads only the date part. No council meets at midnight,
 * so the ambiguity costs nothing and the stability is worth having.
 */
export function supplierDateTimeToUtc(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (HAS_EXPLICIT_ZONE.test(trimmed)) {
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? undefined : toSecondPrecisionUtc(parsed.getTime());
  }

  const dateOnly = DATE_ONLY.exec(trimmed);
  if (dateOnly) {
    const [year, month, day] = dateOnly[1].split("-").map(Number);
    return isRealDate(year, month, day) ? `${dateOnly[1]}T00:00:00Z` : undefined;
  }

  const match = WALL_CLOCK.exec(trimmed);
  if (!match) {
    return undefined;
  }

  const [, year, month, day, hours, minutes, seconds] = match;
  if (
    !isRealDate(Number(year), Number(month), Number(day)) ||
    Number(hours) > 23 ||
    Number(minutes) > 59
  ) {
    return undefined;
  }

  if (hours === "00" && minutes === "00" && (seconds ?? "00") === "00") {
    return `${year}-${month}-${day}T00:00:00Z`;
  }

  return toSecondPrecisionUtc(
    amsterdamWallClockToUtc(
      Number(year),
      Number(month),
      Number(day),
      Number(hours),
      Number(minutes),
      Number(seconds ?? "0"),
    ),
  );
}
