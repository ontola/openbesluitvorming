// BSN (burgerservicenummer) detection for extracted document text.
//
// A BSN is a 9-digit number (8-digit numbers are valid with an implied leading
// zero) that satisfies the "elfproef" variant with an inverted last weight:
// sum(d1*9 + d2*8 + ... + d8*2 + d9*-1) mod 11 == 0.
//
// Roughly 1 in 11 random 9-digit numbers passes the elfproef, so a bare pass is
// not proof. Detection is tiered:
// - "high": a valid BSN with a keyword like "BSN"/"burgerservicenummer" nearby.
// - "medium": an unbroken 9-digit run that passes the elfproef, no keyword.
// Separated formats (e.g. "1234.56.782") and 8-digit numbers are only accepted
// when a keyword is nearby, to avoid matching money amounts and reference
// numbers. BTW/VAT ids and RSINs are RSIN-derived and routinely pass the
// elfproef, so fiscal/bank contexts are excluded, as are digit-dense numeric
// tables (measurement reports).

export interface BsnMatch {
  /** Matched digits with the middle masked, e.g. "12*****82". */
  masked: string;
  index: number;
  digitCount: number;
  nearKeyword: boolean;
  /** Snippet around the match with all long digit runs masked. */
  context: string;
}

export type BsnConfidence = "none" | "medium" | "high";

export interface BsnScanResult {
  found: boolean;
  confidence: BsnConfidence;
  matches: BsnMatch[];
}

const KEYWORD_RE =
  /bsn|burger\s{0,2}service\s{0,2}nummer|sofi[\s-]{0,2}nummer|burgerservicenr|persoonsnummer/gi;
// Separators cover regular space, dot, hyphen, and the non-breaking space that
// PDF extraction frequently emits.
const CANDIDATE_RE = /\d(?:[ .\u00A0-]?\d){6,11}/g;
// Fiscal/bank identifiers directly before the number, e.g. "Btw nr. NL",
// "RSIN:", "KvK-nummer", "IBAN".
const EXCLUSION_BEFORE_RE =
  /(?:btw|vat|rsin|omzetbelasting|fiscaal|kvk|kamer\s+van\s+koophandel|iban|rekeningnummer|bankrekening)[\s-]{0,3}(?:id|nr|no|nummer)?[^a-z]{0,20}(?:nl\s?)?$/i;
const VAT_PREFIX_RE = /nl\s?$/i;
const VAT_SUFFIX_RE = /^\s?b\s?\d{2}(?!\d)/i;
const KEYWORD_WINDOW = 120;
const EXCLUSION_WINDOW = 45;
const CONTEXT_RADIUS = 60;
// Below this letter ratio the surroundings are a numeric table, where bare
// 9-digit elfproef passes are overwhelmingly coincidence.
const MIN_CONTEXT_ALPHA_RATIO = 0.25;

export function isValidBsn(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 8 && digits.length !== 9) {
    return false;
  }
  const padded = digits.padStart(9, "0");
  if (padded === "000000000") {
    return false;
  }
  let sum = 0;
  for (let index = 0; index < 8; index += 1) {
    sum += Number(padded[index]) * (9 - index);
  }
  sum -= Number(padded[8]);
  return sum % 11 === 0;
}

function maskDigits(digits: string): string {
  if (digits.length <= 4) {
    return "*".repeat(digits.length);
  }
  return `${digits.slice(0, 2)}${"*".repeat(digits.length - 4)}${digits.slice(-2)}`;
}

function maskedContext(text: string, index: number, length: number): string {
  const start = Math.max(0, index - CONTEXT_RADIUS);
  const end = Math.min(text.length, index + length + CONTEXT_RADIUS);
  return text
    .slice(start, end)
    .replace(/\d(?:[ .\u00A0-]?\d){4,}/g, (run) => maskDigits(run.replace(/\D/g, "")))
    .replace(/\s+/g, " ")
    .trim();
}

/** Fraction of context tokens mixing letters and digits. Garbled OCR output
 * (old scanned PDFs) is full of tokens like "Sv3so3cjz0e2" and produces
 * accidental elfproef passes; real prose around a BSN has almost none. */
function mixedTokenRatio(text: string, index: number, length: number): number {
  const start = Math.max(0, index - CONTEXT_RADIUS);
  const end = Math.min(text.length, index + length + CONTEXT_RADIUS);
  const tokens = text
    .slice(start, end)
    .split(/\s+/)
    .filter((token) => token.length >= 3);
  if (tokens.length < 4) {
    return 0;
  }
  const mixed = tokens.filter((token) => /\p{L}/u.test(token) && /\d/.test(token)).length;
  return mixed / tokens.length;
}

function alphaRatio(text: string, index: number, length: number): number {
  const start = Math.max(0, index - CONTEXT_RADIUS);
  const end = Math.min(text.length, index + length + CONTEXT_RADIUS);
  const window = text.slice(start, end);
  if (window.length === 0) {
    return 0;
  }
  let letters = 0;
  for (const char of window) {
    if (/\p{L}/u.test(char)) {
      letters += 1;
    }
  }
  return letters / window.length;
}

function keywordPositions(text: string): number[] {
  const positions: number[] = [];
  for (const match of text.matchAll(KEYWORD_RE)) {
    positions.push(match.index ?? 0);
  }
  return positions;
}

export function scanForBsn(text: string): BsnScanResult {
  if (!text) {
    return { found: false, confidence: "none", matches: [] };
  }

  const keywords = keywordPositions(text);
  const matches: BsnMatch[] = [];

  for (const candidate of text.matchAll(CANDIDATE_RE)) {
    const raw = candidate[0];
    const index = candidate.index ?? 0;

    const before = index > 0 ? text[index - 1] : "";
    const after = index + raw.length < text.length ? text[index + raw.length] : "";
    // Reject candidates embedded in a longer number, e.g. "0.123456782",
    // "123456782,50", or a negative table value "-123456782".
    const beforeBefore = index > 1 ? text[index - 2] : "";
    const afterAfter = index + raw.length + 1 < text.length ? text[index + raw.length + 1] : "";
    if (/\d/.test(before) || /\d/.test(after)) {
      continue;
    }
    if (before === "-" || (/[.,]/.test(before) && /\d/.test(beforeBefore))) {
      continue;
    }
    if (/[.,]/.test(after) && /\d/.test(afterAfter)) {
      continue;
    }
    // Letter-glued numbers ("a52…59Q") are ids or OCR noise, never a BSN —
    // except directly after the keyword itself ("BSN123456782").
    if (/\p{L}/u.test(after)) {
      continue;
    }
    if (/\p{L}/u.test(before) && !/bsn$/i.test(text.slice(Math.max(0, index - 3), index))) {
      continue;
    }

    const digits = raw.replace(/\D/g, "");
    if (digits.length !== 8 && digits.length !== 9) {
      continue;
    }
    if (!isValidBsn(digits)) {
      continue;
    }

    // Fiscal/bank identifiers: "Btw nr. NL812345675B01", "RSIN: 123456782".
    const precedingWindow = text.slice(Math.max(0, index - EXCLUSION_WINDOW), index);
    const followingWindow = text.slice(index + raw.length, index + raw.length + 8);
    if (
      EXCLUSION_BEFORE_RE.test(precedingWindow) ||
      VAT_PREFIX_RE.test(precedingWindow) ||
      VAT_SUFFIX_RE.test(followingWindow)
    ) {
      continue;
    }

    if (mixedTokenRatio(text, index, raw.length) > 0.3) {
      continue;
    }

    const nearKeyword = keywords.some((position) => Math.abs(position - index) <= KEYWORD_WINDOW);
    const isPlainNineDigits = digits.length === 9 && raw === digits;
    if (!nearKeyword && !isPlainNineDigits) {
      continue;
    }
    if (!nearKeyword && alphaRatio(text, index, raw.length) < MIN_CONTEXT_ALPHA_RATIO) {
      continue;
    }

    matches.push({
      masked: maskDigits(digits),
      index,
      digitCount: digits.length,
      nearKeyword,
      context: maskedContext(text, index, raw.length),
    });
  }

  const confidence: BsnConfidence = matches.some((match) => match.nearKeyword)
    ? "high"
    : matches.length > 0
      ? "medium"
      : "none";

  return { found: matches.length > 0, confidence, matches };
}
