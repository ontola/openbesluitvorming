// Plan and queue the motion backfill across every iBabs source.
//
// Usage:
//   deno run -A scripts/plan_motion_backfill.ts [--apply] [--limit N] [--from 2016] [--source key]
//
// Without --apply this prints the plan and queues nothing.
//
// Two things decide the plan, both measured rather than assumed:
//
//   * The window is filtered on the entry's MutationDate, not the meeting date.
//     Measured across 142 sitenames: 2016 onwards covers 99.5% of entries,
//     2021 onwards only 75%. So the default start is 2016.
//   * WOOZI_IBABS_MOTION_LIMIT caps entries per run (750 by default). A source
//     above that is split per year; the median source holds 249 entries and
//     needs one run. Splitting blindly would multiply the run count tenfold for
//     no gain, so the count is probed first.
//
// Runs are queued in motions_only mode. A full run would redo the meeting and
// document pass: waterschap_limburg's ten-year window took 479 minutes, nearly
// all of it re-fetching what we already hold.
import { IbabsClient } from "../src/ibabs/client.ts";
import { listSources } from "../src/sources/index.ts";
import type { IbabsSourceDefinition } from "../src/types.ts";

const MOTION_LIST_PATTERN = /moties?|amendement|stemming/i;
const DEFAULT_FROM_YEAR = 2016;

function argValue(name: string): string | null {
  const index = Deno.args.indexOf(`--${name}`);
  return index >= 0 ? (Deno.args[index + 1] ?? null) : null;
}

function hasFlag(name: string): boolean {
  return Deno.args.includes(`--${name}`);
}

interface Plan {
  sourceKey: string;
  sitename: string;
  entries: number;
  windows: Array<[string, string]>;
  note?: string;
}

function yearWindows(fromYear: number, today: string): Array<[string, string]> {
  const windows: Array<[string, string]> = [];
  const lastYear = Number(today.slice(0, 4));
  for (let year = fromYear; year <= lastYear; year += 1) {
    windows.push([`${year}-01-01`, year === lastYear ? today : `${year}-12-31`]);
  }
  return windows;
}

async function planSource(
  client: IbabsClient,
  source: IbabsSourceDefinition,
  fromYear: number,
  today: string,
  cap: number,
): Promise<Plan> {
  const from = `${fromYear}-01-01`;
  const base: Plan = {
    sourceKey: source.key,
    sitename: source.ibabsSitename,
    entries: 0,
    windows: [],
  };

  let lists;
  try {
    lists = await client.getLists(source);
  } catch (error) {
    return { ...base, note: `GetLists failed: ${error instanceof Error ? error.message : error}` };
  }

  const targets = lists.filter((list) => MOTION_LIST_PATTERN.test(list.ListName));
  if (targets.length === 0) {
    return { ...base, note: "no motion registry" };
  }

  let entries = 0;
  for (const list of targets) {
    try {
      entries += (await client.listListEntries(source, list.ListId, from)).length;
    } catch (error) {
      return {
        ...base,
        entries,
        note: `list "${list.ListName}" failed: ${error instanceof Error ? error.message : error}`,
      };
    }
  }

  if (entries === 0) {
    return { ...base, entries, note: "registry is empty in this window" };
  }

  return {
    ...base,
    entries,
    windows: entries > cap ? yearWindows(fromYear, today) : [[from, today]],
  };
}

async function queueRun(
  apiBase: string,
  sourceKey: string,
  [dateFrom, dateTo]: [string, string],
): Promise<void> {
  const response = await fetch(`${apiBase}/api/admin/rerun`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceKey, dateFrom, dateTo, executionMode: "motions_only" }),
  });
  if (!response.ok) {
    throw new Error(`queue failed ${response.status}: ${(await response.text()).slice(0, 120)}`);
  }
}

/** Refuse to plan while imports are running.
 *
 * The planner probes all 166 sources before it queues anything, and those
 * probes hit the same throttled endpoint the running imports do. Started
 * alongside a live queue it lost 58 sources to 403s and starved the workers
 * meanwhile; started against an empty queue it completes cleanly. That is a
 * precondition, not a matter of judgement, so check it rather than remember
 * it. */
async function assertQueueIdle(apiBase: string): Promise<void> {
  if (hasFlag("force")) {
    console.log("warning: --force, planning while imports may be running\n");
    return;
  }

  let summary;
  try {
    const response = await fetch(`${apiBase}/api/admin/summary`);
    summary = (await response.json()).summary;
  } catch (error) {
    throw new Error(
      `Cannot reach ${apiBase} to check the queue: ${
        error instanceof Error ? error.message : error
      }. Pass --force to plan anyway.`,
    );
  }

  const busy = (summary?.queuedCount ?? 0) + (summary?.runningCount ?? 0);
  if (busy > 0) {
    throw new Error(
      `${busy} run(s) still queued or running. The planner competes with them for the ` +
        `same throttled iBabs endpoint and will lose sources to 403s. Wait for the queue ` +
        `to drain, or pass --force.`,
    );
  }
}

async function main(): Promise<void> {
  const apply = hasFlag("apply");
  const fromYear = Number(argValue("from") ?? DEFAULT_FROM_YEAR);
  const limit = Number(argValue("limit") ?? "0");
  const only = argValue("source");
  const cap = Number(Deno.env.get("WOOZI_IBABS_MOTION_LIMIT") ?? "750");
  const apiBase = Deno.env.get("WOOZI_API_BASE") ?? "http://localhost:8787";
  const today = new Date().toISOString().slice(0, 10);

  const sources = listSources()
    .filter((source): source is IbabsSourceDefinition => source.supplier === "ibabs")
    .filter((source) => !only || source.key === only);

  await assertQueueIdle(apiBase);

  console.log(`planning ${sources.length} iBabs sources, from ${fromYear}, cap ${cap}/run`);
  console.log(`mode: ${apply ? "APPLY — queues runs" : "dry run"}\n`);

  const client = new IbabsClient();
  const plans: Plan[] = [];
  for (const source of sources) {
    const plan = await planSource(client, source, fromYear, today, cap);
    plans.push(plan);
    const shape = plan.windows.length === 0
      ? plan.note ?? "nothing to do"
      : plan.windows.length === 1
        ? `1 run (${plan.entries} entries)`
        : `${plan.windows.length} runs, split per year (${plan.entries} entries)`;
    console.log(`  ${plan.sourceKey.padEnd(26)} ${shape}`);
  }

  const actionable = plans.filter((plan) => plan.windows.length > 0);
  const totalRuns = actionable.reduce((sum, plan) => sum + plan.windows.length, 0);
  const totalEntries = actionable.reduce((sum, plan) => sum + plan.entries, 0);
  const split = actionable.filter((plan) => plan.windows.length > 1);

  console.log(`\nsources with motions: ${actionable.length} of ${plans.length}`);
  console.log(`runs to queue:        ${totalRuns}`);
  console.log(`entries to import:    ${totalEntries}`);
  console.log(`split per year:       ${split.length} (${split.map((p) => p.sourceKey).join(", ")})`);

  const skipped = plans.filter((plan) => plan.windows.length === 0 && plan.note?.includes("failed"));
  if (skipped.length > 0) {
    console.log(`\nprobe failures (not queued): ${skipped.length}`);
    for (const plan of skipped) {
      console.log(`  ${plan.sourceKey.padEnd(26)} ${plan.note}`);
    }
  }

  if (!apply) {
    console.log("\nDry run — nothing queued. Re-run with --apply.");
    return;
  }

  let queued = 0;
  for (const plan of actionable) {
    if (limit > 0 && queued >= limit) {
      console.log(`\nstopped at --limit ${limit}; ${totalRuns - queued} runs left to queue`);
      break;
    }
    for (const window of plan.windows) {
      await queueRun(apiBase, plan.sourceKey, window);
      queued += 1;
    }
  }
  console.log(`\nqueued ${queued} runs.`);
}

if (import.meta.main) {
  await main();
}

export const __test__ = { yearWindows, MOTION_LIST_PATTERN };
