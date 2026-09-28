/**
 * `GET /api/ops/health`: one read-only answer to "is the platform alright".
 *
 * Every section is fetched independently and reports its own error, so one
 * unreachable dependency never hides the others:
 *
 * - `host`: load, memory and CPU count of the production host, and the free
 *   space of the state volume. Read from inside the web container: a container
 *   shares the host kernel, so /proc/loadavg and /proc/meminfo are the host's.
 *   Per-container state and logs are not visible from here without the Docker
 *   socket, which this endpoint deliberately does not get.
 * - `extractors`: the remote extraction workers' own `/stats`.
 * - `quickwit`: readiness and the served index's published counters.
 * - `backup`: age of the last successful state backup (its stamp file).
 * - `imports`: the run and ops-job queues from the ops SQLite.
 * - `services`: each compose service as the host agent last saw it
 *   (scripts/ops_host_agent.py). `agent_stale` is true when that was more than
 *   HOST_AGENT_STALE_SECONDS ago, i.e. the agent is not running.
 */

import { getConfigValue } from "../src/config.ts";
import { getOpsQueueHealth, listHostServiceStatus } from "../src/ops/store.ts";
import { QuickwitClient } from "../src/quickwit/client.ts";
import { fetchExtractorStats } from "./extractors.ts";

const BACKUP_STAMP_FILE = ".woozi-backup-stamp";
/** The agent ticks every 15 seconds; four missed ticks means it is not
 * running. */
export const HOST_AGENT_STALE_SECONDS = 60;

export interface OpsHealthOptions {
  /** Directory holding the ops SQLite, the backup stamp and the host status
   * file. Defaults to the directory of WOOZI_KV_PATH. */
  dataDir?: string;
  now?: () => number;
  extractors?: () => Promise<unknown[]>;
  host?: (dataDir: string) => Promise<Record<string, unknown>>;
  quickwit?: Pick<QuickwitClient, "isReady" | "describeIndex" | "configuredIndexId">;
}

async function section<T>(work: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await work();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function defaultDataDir(): Promise<string> {
  const path = await getConfigValue("WOOZI_KV_PATH", "./woozi-ops.sqlite3");
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
}

/** Free space of the filesystem holding `path`, via `df` (Deno has no
 * statfs). The state volume is where the SQLite files and the backup stamp
 * live, and on production the same disk as the Quickwit index. */
async function diskUsage(path: string): Promise<Record<string, unknown>> {
  const { code, stdout } = await new Deno.Command("df", {
    args: ["-Pk", path],
    stdout: "piped",
    stderr: "null",
  }).output();
  if (code !== 0) {
    throw new Error(`df exited ${code}`);
  }
  const fields = new TextDecoder().decode(stdout).trim().split("\n").at(-1)?.split(/\s+/) ?? [];
  const [totalKb, usedKb, availableKb] = [fields[1], fields[2], fields[3]].map(Number);
  if (![totalKb, usedKb, availableKb].every(Number.isFinite)) {
    throw new Error("unexpected df output");
  }
  return {
    path,
    mount: fields[5] ?? null,
    total_gb: Math.round((totalKb / 1e6) * 1.024 * 10) / 10,
    free_gb: Math.round((availableKb / 1e6) * 1.024 * 10) / 10,
    used_percent: Math.round((usedKb / (usedKb + availableKb)) * 100),
  };
}

async function readHostStatus(dataDir: string): Promise<Record<string, unknown>> {
  const [one, five, fifteen] = Deno.loadavg();
  const memory = Deno.systemMemoryInfo();
  const disk = await section(() => diskUsage(dataDir));
  return {
    cpu_count: navigator.hardwareConcurrency,
    load: { "1m": one, "5m": five, "15m": fifteen },
    memory: {
      total_mb: Math.round(memory.total / 1024 / 1024),
      available_mb: Math.round(memory.available / 1024 / 1024),
      used_percent: Math.round(((memory.total - memory.available) / memory.total) * 100),
      swap_used_mb: Math.round((memory.swapTotal - memory.swapFree) / 1024 / 1024),
    },
    disk,
  };
}

function pick(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in record) {
      picked[key] = record[key];
    }
  }
  return picked;
}

export async function getOpsHealth(
  options: OpsHealthOptions = {},
): Promise<Record<string, unknown>> {
  const now = options.now ?? Date.now;
  const dataDir = options.dataDir ?? (await defaultDataDir());
  const quickwit = options.quickwit ?? new QuickwitClient();

  const [host, extractors, quickwitHealth, backup, imports, services] = await Promise.all([
    section(async () => await (options.host ?? readHostStatus)(dataDir)),
    section(async () => await (options.extractors ?? fetchExtractorStats)()),
    section(async () => {
      const ready = await quickwit.isReady();
      const index = await section(async () =>
        pick(await quickwit.describeIndex(), [
          "index_id",
          "num_published_docs",
          "num_published_splits",
          "size_published_docs_uncompressed",
          "size_published_splits",
          "timestamp_field_name",
          "min_timestamp",
          "max_timestamp",
        ]),
      );
      return { ready, index_id: quickwit.configuredIndexId, index };
    }),
    section(async () => {
      try {
        const stat = await Deno.stat(`${dataDir}/${BACKUP_STAMP_FILE}`);
        const at = stat.mtime?.getTime() ?? null;
        return {
          last_backup_at: at === null ? null : new Date(at).toISOString(),
          age_hours: at === null ? null : Math.round(((now() - at) / 3_600_000) * 10) / 10,
        };
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          return { last_backup_at: null, age_hours: null, error: "No backup has completed yet." };
        }
        throw error;
      }
    }),
    section(getOpsQueueHealth),
    section(async () => {
      const rows = await listHostServiceStatus();
      if (rows.length === 0) {
        return { agent_seen_at: null, agent_stale: true, services: [] };
      }
      const seenAt = rows.reduce(
        (latest, row) => (row.seen_at > latest ? row.seen_at : latest),
        "",
      );
      return {
        agent_seen_at: seenAt,
        agent_stale: (now() - Date.parse(seenAt)) / 1000 > HOST_AGENT_STALE_SECONDS,
        services: rows,
      };
    }),
  ]);

  return {
    checked_at: new Date(now()).toISOString(),
    host,
    extractors,
    quickwit: quickwitHealth,
    backup,
    imports,
    services,
  };
}
