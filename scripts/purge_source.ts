// Remove everything a source ever produced, so it can start over clean.
//
// Usage:
//   deno run -A scripts/purge_source.ts [--apply] [--quickwit] [--keep-storage] <sourceKey>
//
// Without --apply this is a dry run: it counts what would go and touches
// nothing.
//
// Written for a source that imported the wrong site — waterschap_limburg
// carried the province's sitename, so ~100k provincial entities sat in the
// index under a water board id. Correcting the catalog does not undo that: the
// corrected import produces different entity ids, so the wrong entities are
// never overwritten and would linger forever.
//
// Three stores hold the data and they have to be handled separately:
//
//   1. The export log — tombstones. This is the one that matters most for
//      reusers: the feed's contract is "follow the changes and you stay
//      correct", so records that simply stop appearing would leave every
//      downstream copy wrong forever. recordDelete both notifies them and
//      flips export_entity_state, which drops the entity from the snapshot.
//   2. Object storage — the source's own prefix. Keys embed supplier,
//      organization type and source key, so one source's objects can never
//      overlap another's.
//   3. Quickwit — optional (--quickwit). If a projection reindex is coming,
//      skipping the source there removes it for free: whatever is not
//      re-projected does not exist in the new index. Pass --quickwit to submit
//      a delete-by-query when you cannot wait for that.
import { collectEntities, countByType, purgeSource } from "../src/ops/purge_source.ts";

function hasFlag(name: string): boolean {
  return Deno.args.includes(`--${name}`);
}

async function main(): Promise<void> {
  const sourceKey = Deno.args.find((arg) => !arg.startsWith("--"));
  if (!sourceKey) {
    console.error("Usage: purge_source.ts [--apply] [--quickwit] [--keep-storage] <sourceKey>");
    Deno.exit(1);
  }

  const result = await purgeSource(sourceKey, {
    apply: hasFlag("apply"),
    quickwit: hasFlag("quickwit"),
    keepStorage: hasFlag("keep-storage"),
  });

  if (!result.storageComplete) {
    Deno.exit(2);
  }
}

if (import.meta.main) {
  await main();
}

export const __test__ = { collectEntities, countByType };
