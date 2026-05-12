// Live probe for the Parlaeus client + extractor.
// Hits the real Apeldoorn opendata endpoint for a small window and prints
// what came back. Skips document materialization (no storage backend wired).
//
// Run: deno run -A scripts/parlaeus_live_probe.ts

import { ParlaeusClient } from "../src/parlaeus/client.ts";
import { ParlaeusExtractor } from "../src/parlaeus/extractor.ts";
import { normalizeParlaeusAgenda, normalizeParlaeusCommittee } from "../src/parlaeus/normalize.ts";
import type { ParlaeusSourceDefinition } from "../src/types.ts";

const source: ParlaeusSourceDefinition = {
  key: "apeldoorn",
  label: "Apeldoorn",
  supplier: "parlaeus",
  organizationType: "gemeente",
  allmanakId: 37707,
  cbsId: "GM0200",
  baseUrl: "https://apeldoorn.parlaeus.nl/receive/opendata",
  sessionId: "0e714fff-182d-497d-8874-c9a512eb4914",
};

const dateFrom = "2024-01-01";
const dateTo = "2024-01-31";

console.log(`\n=== Parlaeus live probe: ${source.key} (${dateFrom} → ${dateTo}) ===\n`);

// 1) Raw client probes.
const client = new ParlaeusClient(source.baseUrl, source.sessionId);

console.log("[1/4] cie_list");
const committees = await client.listCommittees();
console.log(`  got ${committees.length} committees, e.g.:`);
for (const c of committees.slice(0, 3)) {
  console.log(`    - ${c.cmid} ${c.committeecode ?? ""} "${c.committeename ?? ""}"`);
}

console.log("\n[2/4] agenda_list");
const summaries = await client.listAgendaSummaries(dateFrom, dateTo);
console.log(`  got ${summaries.length} agenda summaries, e.g.:`);
for (const s of summaries.slice(0, 5)) {
  console.log(`    - ${s.agid} date=${s.date} time=${s.time}`);
}

if (summaries.length === 0) {
  console.log("  (no agendas in window — extractor test will still run but will be empty)");
}

console.log("\n[3/4] agenda_detail (first summary)");
if (summaries.length > 0) {
  const { detail } = await client.getAgendaDetail(summaries[0].agid);
  console.log(`  agid=${detail.agid} title="${detail.title}"`);
  console.log(`  cmid=${detail.cmid} date=${detail.date} time=${detail.time} cancelled=${detail.cancelled}`);
  console.log(`  ${detail.points?.length ?? 0} points, ${
    (detail.points ?? []).reduce((sum, p) => sum + (p.documents?.length ?? 0), 0)
  } document refs total`);

  const { meeting, documents } = normalizeParlaeusAgenda(source, detail);
  console.log(`  → normalized meeting id: ${meeting.id}`);
  console.log(`  → normalized start_date: ${meeting.start_date} status=${meeting.status}`);
  console.log(`  → ${meeting.agenda?.length ?? 0} agenda items, ${documents.length} unique documents`);
  if (documents[0]) {
    console.log(`  → first doc: ${documents[0].id}`);
    console.log(`     name="${documents[0].name}"`);
    console.log(`     url=${documents[0].original_url}`);
  }

  // Also exercise the committee normalizer.
  if (committees[0]) {
    const c = normalizeParlaeusCommittee(source, committees[0]);
    console.log(`  → normalized committee id: ${c.id} classification=${JSON.stringify(c.classification)}`);
  }
}

// 4) End-to-end extractor — no storage, no document download.
console.log("\n[4/4] extractor end-to-end (mocked storage, allmanak optional)");
const extractor = new ParlaeusExtractor(
  undefined,
  undefined,
  async () => undefined, // no storage → docs will fail to materialize, that's OK for the probe
);

const startedAt = Date.now();
const bundle = await extractor.extractForDateRange(source, dateFrom, dateTo, {
  retainEntities: true,
  retainIssues: true,
});
const elapsedMs = Date.now() - startedAt;

console.log(`  elapsed: ${elapsedMs}ms`);
console.log(`  meetings:   ${bundle.meetings.length}`);
console.log(`  documents:  ${bundle.documents.length} (expected 0 without storage)`);
console.log(`  committees: ${bundle.committees?.length ?? 0}`);
console.log(`  parties:    ${bundle.parties?.length ?? 0}`);
console.log(`  persons:    ${bundle.persons?.length ?? 0}`);
console.log(`  stats: ${JSON.stringify(bundle.stats)}`);
console.log(`  issues (${bundle.issues.length}):`);
const groupedIssues = new Map<string, number>();
for (const issue of bundle.issues) {
  const key = `${issue.severity} ${issue.step} ${issue.message.split(":")[0]}`;
  groupedIssues.set(key, (groupedIssues.get(key) ?? 0) + 1);
}
for (const [key, count] of groupedIssues) {
  console.log(`    ${count}× ${key}`);
}

console.log("\n=== probe complete ===\n");
