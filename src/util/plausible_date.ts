/** How far ahead a council date can plausibly lie. Meetings are planned a
 * year ahead at most; a register entry is dated the day it came in. Anything
 * beyond this is a typo in the source system: Oirschot has an ingekomen stuk
 * dated 2078 and Schiermonnikoog one in 2099, which VNG's weekly check reported
 * as the organisations' newest content (28 September 2026). */
export const MAX_FUTURE_YEARS = 2;

/** The latest instant a date may name and still be taken at its word. */
export function futureDateHorizon(now: Date = new Date()): Date {
  const horizon = new Date(now);
  horizon.setUTCFullYear(horizon.getUTCFullYear() + MAX_FUTURE_YEARS);
  return horizon;
}

/** False for a parseable date beyond the horizon. Unparseable and absent
 * values are someone else's call and pass. */
export function isPlausibleDate(value: string | undefined, now: Date = new Date()): boolean {
  if (!value) {
    return true;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return true;
  }
  return parsed.getTime() <= futureDateHorizon(now).getTime();
}
