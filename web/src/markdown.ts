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
