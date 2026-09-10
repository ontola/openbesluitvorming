import { marked } from "marked";

function parse(markdown: string): string {
  return marked.parse(markdown, { async: false, breaks: true, gfm: true }) as string;
}

function escapeMarkdownSource(markdown: string): string {
  return markdown.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Document text, extracted from someone else's PDF and inserted with
 * {@html}. Escaped before parsing, so nothing in it can become markup. */
export function renderDocumentMarkdown(markdown?: string): string {
  if (!markdown?.trim()) {
    return "<p>Geen documenttekst beschikbaar.</p>";
  }

  return parse(escapeMarkdownSource(markdown));
}

/** Markdown we ship ourselves, currently only API.md.
 *
 * Not pre-escaped, because escaping it twice is what the reader sees:
 * escaping turns `&` into `&amp;`, then marked escapes that again inside a
 * code block, so every curl example rendered `query=x&amp;limit=10` — copy it
 * and the request is wrong. marked escapes code spans by itself, and a file in
 * this repo carries the same trust as the code rendering it. */
export function renderOwnMarkdown(markdown: string): string {
  return parse(markdown);
}

/* The tags a supplier's HTML actually uses. Anything else in angle brackets
 * is text and gets escaped: a stray `<script>` in plain text is not markup. */
const HTML_TAG =
  /<\/?(?:p|br|a|ul|ol|li|strong|b|em|i|u|div|span|h[1-6]|table|thead|tbody|tr|td|th|blockquote|hr)\b[^>]*>/i;

/** Decode the numeric character references a supplier leaves in plain text
 * (`&#xD;` for a carriage return is iBabs's favourite) so they neither show
 * up literally after escaping nor survive as stray `\r`. */
function decodeNumericEntities(text: string): string {
  return text
    .replaceAll(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replaceAll(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replaceAll("\r", "");
}

/** Text a supplier wrote about a meeting or an agenda item, inserted with
 * {@html}.
 *
 * Notubiz hands over HTML and that is shown as it is, as before. iBabs hands
 * over plain text that griffies write with markdown in it: a link such as
 * `[www.harderwijk.nl/vergaderingen](https://www.harderwijk.nl/vergaderingen)`
 * used to appear with its brackets, unclickable (#295). Text without markup
 * is now escaped and rendered as markdown, so links become links and line
 * breaks survive, while nothing in it can become markup of its own. */
export function renderSupplierText(text?: string): string {
  if (!text?.trim()) {
    return "";
  }
  if (HTML_TAG.test(text)) {
    return text;
  }
  return parse(escapeMarkdownSource(decodeNumericEntities(text)));
}
