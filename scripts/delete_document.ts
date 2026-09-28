// Permanently removes documents from OpenBesluitvorming and blocks re-ingest.
//
// Usage:
//   deno run -A scripts/delete_document.ts [--apply] [--reason bsn] <entityId> [<entityId> ...]
//   deno run -A scripts/delete_document.ts [--apply] [--reason bsn] --findings bsn-findings.ndjson [--confidence high]
//
// Without --apply this is a dry run: it reports what would be deleted.
//
// What a deletion does, store by store, is described in
// src/ops/delete_document.ts; the ops endpoint's `delete_document` action runs
// the same code.
//
// Must run where Quickwit ingest and the ops/export SQLite databases are
// reachable (on the server, e.g. inside the openbesluitvorming container).

import { deleteDocuments } from "../src/ops/delete_document.ts";

function argValue(name: string): string | null {
  const index = Deno.args.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < Deno.args.length) {
    return Deno.args[index + 1];
  }
  return null;
}

async function main(): Promise<void> {
  const apply = Deno.args.includes("--apply");
  const reason = argValue("reason") ?? "takedown";
  const findingsPath = argValue("findings");
  const confidenceFilter = argValue("confidence");

  const entityIds = new Set<string>();
  if (findingsPath) {
    const text = await Deno.readTextFile(findingsPath);
    for (const line of text.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      const finding = JSON.parse(line) as { entityId?: string | null; confidence?: string };
      if (!finding.entityId) {
        console.warn(`[warning] finding without entityId skipped: ${line.slice(0, 120)}`);
        continue;
      }
      if (confidenceFilter && finding.confidence !== confidenceFilter) {
        continue;
      }
      entityIds.add(finding.entityId);
    }
  }
  for (const arg of Deno.args) {
    if (arg.startsWith("document:")) {
      entityIds.add(arg);
    }
  }

  if (entityIds.size === 0) {
    console.error(
      "Usage: delete_document.ts [--apply] [--reason <reason>] (<entityId> ... | --findings <file.ndjson> [--confidence high])",
    );
    Deno.exit(1);
  }

  const { failures } = await deleteDocuments(
    [...entityIds],
    { apply, reason },
    (line) => console.log(line),
    (line) => console.error(line),
  );
  if (failures > 0) {
    Deno.exit(1);
  }
}

await main();
