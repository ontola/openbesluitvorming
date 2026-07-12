import { isValidBsn, scanForBsn } from "../src/documents/bsn.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

Deno.test("isValidBsn accepts numbers that pass the elfproef", () => {
  assert(isValidBsn("111222333"), "111222333 should be valid");
  assert(isValidBsn("123456782"), "123456782 should be valid");
  // 8-digit BSN with implied leading zero.
  assert(isValidBsn("23456784"), "23456784 should be valid");
});

Deno.test("isValidBsn rejects invalid numbers", () => {
  assert(!isValidBsn("111222334"), "elfproef failure should be rejected");
  assert(!isValidBsn("123456789"), "123456789 fails the elfproef");
  assert(!isValidBsn("000000000"), "all zeroes should be rejected");
  assert(!isValidBsn("12345678901"), "wrong length should be rejected");
  assert(!isValidBsn(""), "empty should be rejected");
});

Deno.test("scanForBsn flags a keyword-adjacent BSN as high confidence", () => {
  const result = scanForBsn("Naam: J. Jansen, BSN: 123456782, geboren te Utrecht.");
  assert(result.found, "should find the BSN");
  assert(result.confidence === "high", `expected high, got ${result.confidence}`);
  assert(result.matches[0].nearKeyword, "match should be near a keyword");
  assert(
    result.matches[0].masked === "12*****82",
    `masked value wrong: ${result.matches[0].masked}`,
  );
  assert(!result.matches[0].context.includes("123456782"), "context must not contain the raw BSN");
});

Deno.test("scanForBsn flags a bare valid 9-digit run as medium confidence", () => {
  const result = scanForBsn("Het dossier van betrokkene met nummer 111222333 is gesloten.");
  assert(result.found, "should find the number");
  assert(result.confidence === "medium", `expected medium, got ${result.confidence}`);
});

Deno.test("scanForBsn accepts separated and 8-digit formats only near a keyword", () => {
  const withKeyword = scanForBsn("burgerservicenummer 1234.56.782 van aanvrager");
  assert(
    withKeyword.found && withKeyword.confidence === "high",
    "separated + keyword should match",
  );

  const eightDigit = scanForBsn("BSN 23456784 hoort bij de aanvraag");
  assert(eightDigit.found && eightDigit.confidence === "high", "8-digit + keyword should match");

  const separatedNoKeyword = scanForBsn("totaalbedrag 1234.56.782 in de begroting");
  assert(!separatedNoKeyword.found, "separated without keyword should not match");

  const eightNoKeyword = scanForBsn("factuurnummer 23456784 is betaald");
  assert(!eightNoKeyword.found, "8-digit without keyword should not match");
});

Deno.test("scanForBsn rejects letter-glued numbers and OCR gibberish", () => {
  assert(!scanForBsn("registratie S111222333 in het systeem").found, "letter prefix");
  assert(!scanForBsn("code 111222333x is toegekend").found, "letter suffix");
  const glued = scanForBsn("aanvrager met BSN111222333 is akkoord");
  assert(glued.found && glued.confidence === "high", "BSN-glued number should still match");
  const ocr =
    "ao85sd55 gogo39jj3e Sv3so3cjz0e2 Ssosj Zeo08 45 3 111222333 38 b5SToljzs 235 ds x53o gio53n0s5 oBoz2sc";
  assert(!scanForBsn(ocr).found, "OCR gibberish context should be rejected");
});

Deno.test("scanForBsn ignores common false positives", () => {
  assert(!scanForBsn("totaal 123.456.782 euro subsidie").found, "grouped money amount");
  assert(!scanForBsn("bel 0612345678 voor vragen").found, "10-digit phone number");
  assert(!scanForBsn("bedrag 0,123456782 procent").found, "decimal fraction tail");
  assert(!scanForBsn("meting 123456782,5 mm").found, "decimal number head");
  assert(!scanForBsn("kenmerk 111222334 in het register").found, "elfproef failure");
  assert(!scanForBsn("").found, "empty text");
});

Deno.test("scanForBsn excludes fiscal and bank identifiers", () => {
  assert(!scanForBsn("VAT/BTW-ID-Nr.: NL 123456782 B01 Directeur").found, "VAT id with NL/B01");
  assert(!scanForBsn("Btw nr. NL123456782B01 - IBAN NL72ABNA0123456782").found, "inline VAT id");
  assert(!scanForBsn("RSIN: 123456782 van de stichting").found, "RSIN");
  assert(!scanForBsn("KvK-nummer 123456782 te Rotterdam").found, "KvK context");
  assert(!scanForBsn("Btw-nummer: NL001122312B01 IBAN: NL31BNGH0285123452").found, "VAT + IBAN");
  // A real BSN keyword wins from a fiscal keyword further away.
  const result = scanForBsn("KvK dossier bijgevoegd. BSN aanvrager: 123456782.");
  assert(result.found && result.confidence === "high", "BSN keyword should still match");
});

Deno.test("scanForBsn excludes digit-dense numeric tables", () => {
  const table =
    "0,80 0,80 0,80 76 111222333 17 6,00 0,97 110,94 0 dB 0,80 0,80 152 48,10 0 dB 0,80";
  assert(!scanForBsn(table).found, "bare match inside a numeric table should be dropped");
  assert(!scanForBsn("meetwaarde -111222333 Kerkstraat").found, "negative table value");
});

Deno.test("scanForBsn reports multiple matches with positions", () => {
  const text = "BSN 123456782 en verderop nog een nummer 111222333 in de tekst.";
  const result = scanForBsn(text);
  assert(result.matches.length === 2, `expected 2 matches, got ${result.matches.length}`);
  assert(result.confidence === "high", "any keyword match should make the result high");
  assert(result.matches[0].index < result.matches[1].index, "matches should be in order");
});
