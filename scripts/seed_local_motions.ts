// Seed a local Quickwit with real meetings and motions, so the GUI can be
// pointed at an agenda that actually has moties hanging off its agenda items.
//
//   sh scripts/docker-compose.sh up -d quickwit
//   deno run -A scripts/seed_local_motions.ts
//   pnpm run build:web && deno run -A web/server.ts
//
// Utrecht comes from captured iBabs responses (the API is IP-whitelisted, so a
// laptop can't reach it) and is the only supplier with per-member votes.
// Alkmaar is fetched live from Notubiz's public API.
import { __test__ as ibabsClientTest } from "../src/ibabs/client.ts";
import { normalizeIbabsMeeting, normalizeIbabsMotion } from "../src/ibabs/normalize.ts";
import { NotubizClient } from "../src/notubiz/client.ts";
import { normalizeNotubizMeeting } from "../src/notubiz/normalize.ts";
import { isMotionModule, normalizeNotubizMotion } from "../src/notubiz/motions.ts";
import { MeetingIndex } from "../src/motions/normalize.ts";
import { buildEntityCommitEvent } from "../src/events/entity_commit.ts";
import { projectEntityCommitToQuickwitDocuments } from "../src/quickwit/project.ts";
import { QuickwitClient } from "../src/quickwit/client.ts";
import { getIbabsSource, getNotubizSource } from "../src/sources/index.ts";
import type { QuickwitSearchDocument } from "../src/quickwit/project.ts";
import type { MotionEntity, WooziEntity } from "../src/types.ts";

const fixture = (name: string) =>
  Deno.readTextFile(new URL(`../tests/fixtures/${name}`, import.meta.url));

const documents: QuickwitSearchDocument[] = [];
const seeded: Array<{ label: string; meetingId: string; motions: MotionEntity[] }> = [];

async function index(entity: WooziEntity): Promise<void> {
  const event = await buildEntityCommitEvent(entity);
  documents.push(...projectEntityCommitToQuickwitDocuments(event));
}

// ---------------------------------------------------------------- iBabs
async function seedUtrecht(): Promise<void> {
  const source = getIbabsSource("utrecht");
  const meetingsXml = await Deno.readTextFile("/tmp/utrecht_meeting.xml");
  const rawMeetings = ibabsClientTest.parseMeetingsXml(meetingsXml);
  // The real type map matters: the motion's back-reference says "Gemeenteraad",
  // and without it the meeting falls back to a generic "Vergadering <date>"
  // name that the index can't match against.
  const typesXml = await Deno.readTextFile("/tmp/utrecht_types.xml");
  const typeMap = new Map(
    ibabsClientTest.parseMeetingTypesXml(typesXml).map((type) => [
      type.Id,
      type.Description ?? type.Meetingtype ?? type.Id,
    ]),
  );

  const meetingIndex = new MeetingIndex();
  const meetings = [];
  for (const raw of rawMeetings) {
    const meeting = normalizeIbabsMeeting(source, raw, typeMap);
    meetingIndex.add(meeting);
    meetings.push(meeting);
    await index(meeting);
  }

  const lists = ibabsClientTest.parseListsXml(await fixture("ibabs_lists_response.xml"));
  const list = lists.find((candidate) => candidate.ListName === "Moties")!;
  const entries = ibabsClientTest.parseListEntriesXml(
    await fixture("ibabs_list_entries_response.xml"),
  );
  const detail = ibabsClientTest.parseListEntryXml(
    await fixture("ibabs_list_entry_response.xml"),
    entries[0].EntryId,
  );
  const votes = ibabsClientTest.parseListEntryVotesXml(
    await fixture("ibabs_list_entry_votes_response.xml"),
  );

  const motion = normalizeIbabsMotion(source, list, entries[0], detail, votes, meetingIndex);
  await index(motion);

  if (!motion.meeting) {
    throw new Error(
      `Utrecht motion did not link to a meeting (hint: ${motion.agenda_item_hint}); ` +
        `meetings on file: ${meetings.map((m) => m.name).join(", ")}`,
    );
  }
  const owner = meetings.find((meeting) => meeting.id === motion.meeting)!;
  console.log(
    `  utrecht: ${owner.name} — motion linked to agenda item ${motion.agenda_item ? "yes" : "no"}`,
  );
  seeded.push({ label: `Utrecht — ${owner.name}`, meetingId: owner.id, motions: [motion] });
}

// -------------------------------------------------------------- Notubiz
async function seedAlkmaar(): Promise<void> {
  const source = getNotubizSource("alkmaar");
  const client = new NotubizClient();
  const attributes = await client.getOrganizationAttributes(source.notubizOrganizationId);

  const events = (await client.listEvents(
    source.notubizOrganizationId,
    "2026-02-01",
    "2026-03-10",
    1,
  )) as { events?: Array<Record<string, unknown>> };

  const meetingIndex = new MeetingIndex();
  const meetings = [];
  for (const event of (events.events ?? []).filter((e) => e.permission_group === "public")) {
    try {
      const response = (await client.getMeeting(event.id as number)) as { meeting?: unknown };
      if (!response.meeting) continue;
      const meeting = normalizeNotubizMeeting(source, attributes, response.meeting);
      meetingIndex.add(meeting);
      meetings.push(meeting);
      await index(meeting);
    } catch (error) {
      // Some listed meetings answer 401/403 on detail; the real extractor
      // records those as a warning and moves on.
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("401") && !message.includes("403")) throw error;
      console.log(`  skipped meeting ${event.id}: not accessible`);
    }
  }
  console.log(`  alkmaar meetings: ${meetings.length}`);

  const modules = await client.listModules(source.notubizOrganizationId);
  const motions: MotionEntity[] = [];
  for (const module of modules.filter(isMotionModule)) {
    const items = await client.listModuleItems(
      source.notubizOrganizationId,
      module.id,
      "2026-02-01",
      "2026-03-10",
    );
    for (const item of items) {
      const motion = normalizeNotubizMotion(source, module, item, meetingIndex);
      motions.push(motion);
      await index(motion);
    }
  }
  console.log(`  alkmaar motions: ${motions.length} (linked: ${motions.filter((m) => m.meeting).length})`);

  // Show the meeting that ended up with the most motions attached.
  const byMeeting = new Map<string, MotionEntity[]>();
  for (const motion of motions) {
    if (motion.meeting) {
      byMeeting.set(motion.meeting, [...(byMeeting.get(motion.meeting) ?? []), motion]);
    }
  }
  const best = [...byMeeting.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  if (best) {
    const meeting = meetings.find((candidate) => candidate.id === best[0])!;
    seeded.push({
      label: `Alkmaar — ${meeting.name} (${meeting.start_date.slice(0, 10)})`,
      meetingId: best[0],
      motions: best[1],
    });
  }
}

console.log("seeding...");
await seedUtrecht();
await seedAlkmaar();

const quickwit = new QuickwitClient();
await quickwit.waitUntilReady();
await quickwit.ensureIndex(new URL("../quickwit/index-config.json", import.meta.url).pathname);
await quickwit.ingestDocuments(documents);
console.log(`\nindexed ${documents.length} quickwit documents`);

console.log("\nOpen deze vergaderingen in de GUI:");
for (const entry of seeded) {
  console.log(`\n  ${entry.label}`);
  console.log(`  /?detail=${encodeURIComponent(entry.meetingId)}`);
  for (const motion of entry.motions.slice(0, 6)) {
    console.log(
      `    - ${motion.name.slice(0, 52).padEnd(52)} ${String(motion.result).padEnd(11)}` +
        ` ${motion.tally ? `${motion.tally.in_favour}v/${motion.tally.against}t` : ""}` +
        `${motion.vote_summary ? " [stemverhouding als tekst]" : ""}`,
    );
  }
}
