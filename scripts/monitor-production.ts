type ServerTiming = Record<string, number>;

type Alert = {
  key: string;
  severity: "warning" | "critical";
  title: string;
  details: Record<string, unknown>;
};

type AlertState = Record<string, number>;

const DEFAULT_TERMS = [
  "woningbouw",
  "wateroverlast",
  "fietsbrug",
  "dorpshuis",
  "groenbeheer",
  "laadinfra",
  "subsidieplafond",
  "verkeersveiligheid",
  "openbareverlichting",
  "mantelzorgwoning",
  "klimaatadaptatie",
  "speelruimtebeleid",
  "parkeerhub",
  "schuldhulpverlening",
  "omgevingsvisie",
  "bedrijventerrein",
  "dijkversterking",
  "riolering",
  "jeugdraad",
  "sporthal",
  "bibliotheek",
  "geluidswal",
  "warmtenet",
  "zonnepark",
  "afvalscheiding",
  "waterberging",
  "wijkcentrum",
  "schoolroute",
  "kunstgrasveld",
  "brugrenovatie",
  "bomenkap",
  "fietsstraat",
  "marktvisie",
  "woonwagen",
  "natuurbeheer",
  "toegankelijkheid",
  "grondbeleid",
  "zwembad",
  "begroting",
  "jaarrekening",
  "inkoopbeleid",
  "veiligheidsplan",
  "dorpsplein",
  "regenwater",
  "speelplaats",
  "parkeerdruk",
  "woningcorporatie",
  "welstandsnota",
  "arbeidsmigranten",
  "energiearmoede",
  "leerlingenvervoer",
  "evenementenbeleid",
  "waterkwaliteit",
  "rekenkamer",
  "participatie",
  "gebiedsvisie",
  "verkeersplein",
  "fietspad",
  "groenstrook",
  "handhaving",
];

function envNumber(name: string, fallback: number): number {
  const value = Number(Deno.env.get(name) ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}

function parseServerTiming(value: string | null): ServerTiming {
  if (!value) {
    return {};
  }

  const timings: ServerTiming = {};
  for (const entry of value.split(",")) {
    const [namePart, ...params] = entry.trim().split(";");
    const duration = params.find((param) => param.trim().startsWith("dur="));
    if (!duration) {
      continue;
    }
    const durationMs = Number(duration.trim().slice("dur=".length));
    if (Number.isFinite(durationMs)) {
      timings[namePart.trim()] = durationMs;
    }
  }
  return timings;
}

function searchTerms(): string[] {
  const configured = Deno.env.get("WOOZI_MONITOR_SEARCH_TERMS")?.trim();
  if (!configured) {
    return DEFAULT_TERMS;
  }
  return configured
    .split(",")
    .map((term) => term.trim())
    .filter(Boolean);
}

function pickSearchTerm(): string {
  const terms = searchTerms();
  const minute = Math.floor(Date.now() / 60_000);
  return terms[minute % terms.length] ?? "begroting";
}

async function runText(command: string, args: string[]): Promise<string> {
  const child = new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await child.output();
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr).trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${stderr}`);
  }
  return new TextDecoder().decode(output.stdout).trim();
}

function alert(
  alerts: Alert[],
  key: string,
  severity: Alert["severity"],
  title: string,
  details: Record<string, unknown>,
): void {
  alerts.push({ key, severity, title, details });
}

async function checkSearch(alerts: Alert[]): Promise<void> {
  const baseUrl = Deno.env.get("WOOZI_MONITOR_BASE_URL") ?? "https://openbesluitvorming.nl";
  const timeoutMs = envNumber("WOOZI_MONITOR_SEARCH_TIMEOUT_MS", 15_000);
  const totalWarnMs = envNumber("WOOZI_MONITOR_SEARCH_WARN_MS", 2_000);
  const totalCriticalMs = envNumber("WOOZI_MONITOR_SEARCH_CRITICAL_MS", 8_000);
  const quickwitWarnMs = envNumber("WOOZI_MONITOR_QUICKWIT_WARN_MS", 1_500);
  const term = pickSearchTerm();
  const url = new URL("/api/search", baseUrl);
  url.searchParams.set("query", term);
  url.searchParams.set("sort", "date_desc");
  url.searchParams.set("offset", "0");
  url.searchParams.set("limit", "24");

  const startedAt = performance.now();
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "user-agent": "woozi-monitor/1.0",
      },
    });
  } catch (error) {
    alert(alerts, "search_unreachable", "critical", "Search endpoint unreachable", {
      url: url.toString(),
      term,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const elapsedMs = performance.now() - startedAt;
  const timings = parseServerTiming(response.headers.get("server-timing"));
  const body = await response.text();
  const totalMs = timings.total ?? elapsedMs;
  const quickwitMs = timings.quickwit ?? 0;

  if (!response.ok) {
    alert(alerts, "search_http_error", "critical", "Search endpoint returned an error", {
      status: response.status,
      total_ms: Math.round(totalMs),
      timings,
      term,
      body_preview: body.slice(0, 300),
    });
    return;
  }

  if (totalMs >= totalCriticalMs) {
    alert(alerts, "search_critical_slow", "critical", "Search is critically slow", {
      total_ms: Math.round(totalMs),
      quickwit_ms: Math.round(quickwitMs),
      timings,
      term,
    });
  } else if (totalMs >= totalWarnMs || quickwitMs >= quickwitWarnMs) {
    alert(alerts, "search_slow", "warning", "Search is slow", {
      total_ms: Math.round(totalMs),
      quickwit_ms: Math.round(quickwitMs),
      timings,
      term,
    });
  }
}

async function checkDisk(alerts: Alert[]): Promise<void> {
  if (Deno.env.get("WOOZI_MONITOR_REQUIRE_LOCAL_CHECKS") !== "1") {
    return;
  }

  const warnPercent = envNumber("WOOZI_MONITOR_DISK_WARN_PERCENT", 80);
  const criticalPercent = envNumber("WOOZI_MONITOR_DISK_CRITICAL_PERCENT", 90);

  try {
    const output = await runText("df", ["-Pk", "/"]);
    const line = output.split("\n").at(-1);
    const columns = line?.trim().split(/\s+/) ?? [];
    const usedPercent = Number(columns[4]?.replace("%", ""));
    if (!Number.isFinite(usedPercent)) {
      return;
    }
    if (usedPercent >= criticalPercent) {
      alert(alerts, "disk_critical", "critical", "Root disk is critically full", {
        used_percent: usedPercent,
        df: line,
      });
    } else if (usedPercent >= warnPercent) {
      alert(alerts, "disk_warning", "warning", "Root disk is getting full", {
        used_percent: usedPercent,
        df: line,
      });
    }
  } catch (error) {
    if (Deno.env.get("WOOZI_MONITOR_REQUIRE_LOCAL_CHECKS") === "1") {
      alert(alerts, "disk_check_failed", "warning", "Disk check failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function checkDocker(alerts: Alert[]): Promise<void> {
  if (Deno.env.get("WOOZI_MONITOR_REQUIRE_LOCAL_CHECKS") !== "1") {
    return;
  }

  const minCacheSplits = envNumber("WOOZI_MONITOR_QUICKWIT_MIN_CACHE_SPLITS", 60);
  const maxRestarts = envNumber("WOOZI_MONITOR_CONTAINER_RESTART_WARN", 0);

  try {
    const inspect = await runText("docker", [
      "inspect",
      "-f",
      "{{.Name}} {{.RestartCount}} {{.State.Status}}",
      "woozi-quickwit-1",
      "woozi-openbesluitvorming-1",
    ]);
    for (const line of inspect.split("\n").filter(Boolean)) {
      const [name, restartText, status] = line.trim().split(/\s+/);
      const restarts = Number(restartText);
      if (status !== "running") {
        alert(alerts, `container_${name}_not_running`, "critical", "Container is not running", {
          name,
          status,
        });
      }
      if (Number.isFinite(restarts) && restarts > maxRestarts) {
        alert(alerts, `container_${name}_restarted`, "warning", "Container has restarted", {
          name,
          restarts,
        });
      }
    }

    const worker = await runText("docker", [
      "ps",
      "--filter",
      "name=woozi-worker",
      "--format",
      "{{.Names}} {{.Status}}",
    ]);
    if (worker.trim()) {
      alert(alerts, "worker_running", "warning", "Worker container is running", {
        worker,
      });
    }

    const cacheOutput = await runText("docker", [
      "exec",
      "woozi-quickwit-1",
      "sh",
      "-lc",
      "du -sk /quickwit/qwdata/searcher-split-cache 2>/dev/null; find /quickwit/qwdata/searcher-split-cache -maxdepth 1 -type f 2>/dev/null | wc -l",
    ]);
    const [duLine, splitLine] = cacheOutput.split("\n");
    const cacheKb = Number(duLine?.trim().split(/\s+/)[0]);
    const splitCount = Number(splitLine?.trim());
    if (Number.isFinite(splitCount) && splitCount < minCacheSplits) {
      alert(alerts, "quickwit_cache_cold", "warning", "Quickwit split cache looks cold", {
        split_count: splitCount,
        cache_gb: Number.isFinite(cacheKb) ? Math.round(cacheKb / 1024 / 1024) : undefined,
      });
    }
  } catch (error) {
    if (Deno.env.get("WOOZI_MONITOR_REQUIRE_LOCAL_CHECKS") === "1") {
      alert(alerts, "docker_check_failed", "warning", "Docker checks failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function readState(path: string): Promise<AlertState> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as AlertState;
  } catch {
    return {};
  }
}

async function writeState(path: string, state: AlertState): Promise<void> {
  await Deno.writeTextFile(path, JSON.stringify(state, null, 2));
}

async function sendWebhook(alerts: Alert[]): Promise<void> {
  const webhookUrl = Deno.env.get("WOOZI_ALERT_WEBHOOK_URL")?.trim();
  if (!webhookUrl || alerts.length === 0) {
    return;
  }

  const statePath = Deno.env.get("WOOZI_MONITOR_STATE_PATH") ?? "/tmp/woozi-monitor-alerts.json";
  const cooldownMs = envNumber("WOOZI_MONITOR_ALERT_COOLDOWN_MS", 15 * 60_000);
  const state = await readState(statePath);
  const now = Date.now();
  const unsuppressed = alerts.filter((item) => now - (state[item.key] ?? 0) >= cooldownMs);
  if (unsuppressed.length === 0) {
    return;
  }

  const criticalCount = unsuppressed.filter((item) => item.severity === "critical").length;
  const text = [
    `${criticalCount > 0 ? "CRITICAL" : "WARNING"} OpenBesluitvorming monitor: ${unsuppressed.length} alert(s)`,
    ...unsuppressed.map((item) => `- ${item.title}: ${JSON.stringify(item.details)}`),
  ].join("\n");

  const configuredFormat = Deno.env.get("WOOZI_ALERT_WEBHOOK_FORMAT") ?? "auto";
  const format =
    configuredFormat === "auto" && webhookUrl.startsWith("https://discord.com/api/webhooks/")
      ? "discord"
      : configuredFormat;
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": format === "text" ? "text/plain; charset=utf-8" : "application/json",
    },
    body:
      format === "text"
        ? text
        : format === "discord"
          ? JSON.stringify({ content: text })
          : JSON.stringify({
              text,
              alerts: unsuppressed,
            }),
  });

  if (!response.ok) {
    throw new Error(`alert webhook failed ${response.status}: ${await response.text()}`);
  }

  for (const item of unsuppressed) {
    state[item.key] = now;
  }
  await writeState(statePath, state);
}

async function main(): Promise<void> {
  const alerts: Alert[] = [];
  await checkSearch(alerts);
  await checkDisk(alerts);
  await checkDocker(alerts);

  const result = {
    event: "monitor_run",
    ok: alerts.length === 0,
    alert_count: alerts.length,
    alerts,
  };
  console.log(JSON.stringify(result));
  await sendWebhook(alerts);

  if (alerts.some((item) => item.severity === "critical")) {
    Deno.exit(2);
  }
  if (alerts.length > 0) {
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
