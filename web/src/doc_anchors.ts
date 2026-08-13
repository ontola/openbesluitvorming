/** Heading anchors for the API documentation panel.
 *
 * API.md links to its own sections — `[Rate limits](#rate-limits)` — and those
 * links work on GitHub because GitHub gives every heading an id. `marked` does
 * not (it dropped `headerIds` in v5), so in the rendered panel every one of
 * those links pointed at nothing: the click changed the page hash, which the
 * router reads as "not #api" and closed the docs the reader was trying to
 * navigate. Adding the ids here is what makes the anchors resolve at all.
 *
 * Deliberately a string transform rather than a DOM pass: the slug rules are
 * the interesting part and this way they are testable without a browser.
 */

/** GitHub's heading slug: lowercase, punctuation dropped, spaces to hyphens.
 * `## Use case: voting data` becomes `use-case-voting-data`, which is what the
 * links in API.md already assume.
 *
 * Runs of hyphens are deliberately not collapsed, because GitHub does not
 * collapse them either — `Zoeken — één organisatie` is `zoeken--één-organisatie`
 * there. The point of this function is that a link that works in the file on
 * GitHub also works in the rendered panel, so where the two rules disagree,
 * GitHub wins. */
export function slugifyHeading(text: string): string {
  return (
    text
      .trim()
      .toLowerCase()
      // Unicode-aware: a Dutch heading may hold ë or é, and those are letters.
      .replace(/[^\p{L}\p{N}\s-]+/gu, "")
      .replace(/\s/g, "-")
      .replace(/^-+|-+$/g, "")
  );
}

const HEADING = /<(h[1-6])([^>]*)>([\s\S]*?)<\/\1>/g;
const TAG = /<[^>]*>/g;

/** Give every heading in rendered markdown an id, skipping any that already
 * has one.
 *
 * Repeated headings get a numeric suffix the way GitHub does it. API.md has
 * two "What to expect" sections — one per use case — and without this both
 * would answer to the same id, so half the links would land in the wrong
 * place rather than fail visibly. */
export function withHeadingAnchors(html: string): string {
  const used = new Map<string, number>();

  return html.replace(HEADING, (match, tag, attributes: string, inner: string) => {
    if (/\bid\s*=/.test(attributes)) {
      return match;
    }

    const base = slugifyHeading(inner.replace(TAG, ""));
    if (!base) {
      return match;
    }

    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    const id = seen === 0 ? base : `${base}-${seen}`;

    return `<${tag}${attributes} id="${id}">${inner}</${tag}>`;
  });
}
