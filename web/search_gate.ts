/** How many phrase searches may run at the same time, server-wide.
 *
 * A phrase is the one search a single anonymous caller can make heavy enough
 * to take the platform down. Before Quickwit evaluates it, every split loads
 * the full postings *with positions* of each word in it, whatever the other
 * filters say: a three-word phrase limited to Gouda spent 2.8 s in Quickwit
 * where the same three words unquoted spent 0.26 s (measured 2026-10-16). For
 * a word like "de" those positions run through most of the corpus. On
 * 2026-10-15 seven such phrases in a few minutes, each within the rate limit,
 * made the site unreachable for about eight minutes (#348).
 *
 * The rate limiter cannot prevent that on its own: it budgets requests per
 * caller over a minute, and the damage is several heavy requests at once. So
 * phrases also queue for a small number of slots, and a phrase that finds them
 * all taken is refused at once with 503 `search_busy` rather than piling up. */
export class SearchGate {
  private running = 0;

  constructor(readonly capacity: number) {}

  get inUse(): number {
    return this.running;
  }

  /** A release function when a slot was free, undefined when none was. */
  tryAcquire(): (() => void) | undefined {
    if (this.running >= this.capacity) {
      return undefined;
    }
    this.running += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.running -= 1;
      }
    };
  }
}

const DEFAULT_PHRASE_SEARCH_SLOTS = 2;

export function phraseSearchSlots(): number {
  const value = Number(
    Deno.env.get("WOOZI_PHRASE_SEARCH_SLOTS") ?? String(DEFAULT_PHRASE_SEARCH_SLOTS),
  );
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_PHRASE_SEARCH_SLOTS;
}
