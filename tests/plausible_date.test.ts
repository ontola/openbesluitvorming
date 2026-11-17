import { isPlausibleDate } from "../src/util/plausible_date.ts";
import { normalizeIbabsRegisterDocuments } from "../src/ibabs/normalize.ts";
import { getIbabsSource } from "../src/sources/index.ts";

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

const NOW = new Date("2026-09-28T09:00:00Z");

Deno.test("a date decades ahead is implausible, next year's meeting is not", () => {
  assertEquals(isPlausibleDate("2078-01-01T00:00:00Z", NOW), false, "2078");
  assertEquals(isPlausibleDate("2099-12-31", NOW), false, "2099");
  assertEquals(isPlausibleDate("2027-06-30T19:30:00Z", NOW), true, "next year");
  assertEquals(isPlausibleDate("1998-03-01", NOW), true, "the past");
  assertEquals(isPlausibleDate(undefined, NOW), true, "absent");
  assertEquals(isPlausibleDate("onzin", NOW), true, "unparseable is not this check's call");
});

Deno.test("an iBabs register entry with a typo'd year is dated by its last change", () => {
  // Oirschot, "Toelichting afdoeningsadviezen ingekomen stukken": the entry's
  // Datum reads 1-1-2078, and it headed every date-sorted list for Oirschot.
  const list = { ListId: "list-9", ListName: "Ingekomen stukken" };
  const [document] = normalizeIbabsRegisterDocuments(
    getIbabsSource("oirschot"),
    list,
    {
      EntryId: "e-2078",
      EntryTitle: "Toelichting afdoeningsadviezen ingekomen stukken",
      MutationDate: "2025-11-04T09:12:00",
      ListId: list.ListId,
      ListName: list.ListName,
      ListCanVote: false,
    },
    {
      EntryId: "e-2078",
      Values: { Datum: "1-1-2078" },
      Documents: [{ Id: "d-1", FileName: "toelichting.pdf" }],
    },
  );
  assertEquals(document.last_discussed_at, "2025-11-04T00:00:00Z", "falls back to MutationDate");
});
