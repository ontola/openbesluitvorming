export interface MarkdownQualityMetrics {
  totalChars: number;
  controlCharRatio: number;
  interleavedControlRatio: number;
  replacementCharRatio: number;
  symbolCharRatio: number;
  readableTokenRatio: number;
  alphaCharRatio: number;
}

export interface MarkdownQualityAssessment {
  score: number;
  status: "good" | "suspect";
  metrics: MarkdownQualityMetrics;
}

const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const REPLACEMENT_CHAR_RE = /\uFFFD/g;
const TOKEN_RE = /\S+/gu;
const LETTER_RE = /\p{L}/u;
const SYMBOL_RE = /[\p{S}]/u;

function isControlChar(char: string): boolean {
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(char);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function assessMarkdownQuality(markdown: string): MarkdownQualityAssessment {
  const totalChars = markdown.length;
  if (totalChars === 0) {
    return {
      score: 0,
      status: "suspect",
      metrics: {
        totalChars,
        controlCharRatio: 0,
        interleavedControlRatio: 0,
        replacementCharRatio: 0,
        symbolCharRatio: 0,
        readableTokenRatio: 0,
        alphaCharRatio: 0,
      },
    };
  }

  const controlChars = markdown.match(CONTROL_CHAR_RE)?.length ?? 0;
  const replacementChars = markdown.match(REPLACEMENT_CHAR_RE)?.length ?? 0;
  let alphaChars = 0;
  let symbolChars = 0;
  let interleavedControls = 0;

  for (let index = 0; index < markdown.length; index += 1) {
    const char = markdown[index];
    if (LETTER_RE.test(char)) {
      alphaChars += 1;
      continue;
    }
    if (SYMBOL_RE.test(char)) {
      symbolChars += 1;
    }
    if (isControlChar(char)) {
      const previous = index > 0 ? markdown[index - 1] : "";
      const next = index < markdown.length - 1 ? markdown[index + 1] : "";
      if (LETTER_RE.test(previous) || LETTER_RE.test(next)) {
        interleavedControls += 1;
      }
    }
  }

  const tokens = markdown.match(TOKEN_RE) ?? [];
  const readableTokens = tokens.filter((token) => {
    if (token.length < 3) {
      return false;
    }
    let letters = 0;
    for (const char of token) {
      if (LETTER_RE.test(char)) {
        letters += 1;
      }
    }
    return letters / token.length >= 0.6;
  }).length;

  const controlCharRatio = controlChars / totalChars;
  const replacementCharRatio = replacementChars / totalChars;
  const symbolCharRatio = symbolChars / totalChars;
  const alphaCharRatio = alphaChars / totalChars;
  const interleavedControlRatio = interleavedControls / totalChars;
  const readableTokenRatio = tokens.length > 0 ? readableTokens / tokens.length : 1;

  let score = 1;
  score -= Math.min(0.7, controlCharRatio * 8);
  score -= Math.min(0.45, interleavedControlRatio * 12);
  score -= Math.min(0.25, replacementCharRatio * 5);
  score -= Math.min(0.15, symbolCharRatio * 1.5);

  if (tokens.length >= 8) {
    score -= Math.min(0.3, Math.max(0, 0.75 - readableTokenRatio) * 0.8);
  }

  if (totalChars >= 80 && alphaCharRatio < 0.45) {
    score -= Math.min(0.2, (0.45 - alphaCharRatio) * 0.8);
  }

  score = Math.max(0, Math.min(1, score));

  return {
    score: round(score),
    status: score < 0.72 ? "suspect" : "good",
    metrics: {
      totalChars,
      controlCharRatio: round(controlCharRatio),
      interleavedControlRatio: round(interleavedControlRatio),
      replacementCharRatio: round(replacementCharRatio),
      symbolCharRatio: round(symbolCharRatio),
      readableTokenRatio: round(readableTokenRatio),
      alphaCharRatio: round(alphaCharRatio),
    },
  };
}
