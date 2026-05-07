// Probe iBabs SOAP API for vote- and list-related data, through the whitelisted
// production IP. Run with the SOCKS proxy active:
//
//   ssh -i ~/.ssh/woozi_beta_deploy_ed25519 -D 1080 -N -f root@91.98.32.151
//   IBABS_PROXY_URL=socks5://localhost:1080 \
//     deno run -A scripts/explore_ibabs_votes.ts [sitename] [months]
//
// Dumps raw XML responses to /tmp/ibabs-probe-*.xml so they can be re-inspected.

const ENDPOINT = "https://wcf.ibabs.eu/api/Public.svc";
const SITENAME = Deno.args[0] ?? "amstelveen";
const MONTHS = Number(Deno.args[1] ?? "6");

const proxyUrl = Deno.env.get("IBABS_PROXY_URL");
const client = proxyUrl ? Deno.createHttpClient({ proxy: { url: proxyUrl } }) : undefined;

async function soap(op: string, params: string): Promise<string> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body><${op} xmlns="http://tempuri.org/">${params}</${op}></s:Body>
</s:Envelope>`;
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "text/xml; charset=utf-8",
      soapaction: `"http://tempuri.org/IPublic/${op}"`,
      "user-agent": "woozi-probe/0.1",
    },
    body,
    signal: AbortSignal.timeout(60_000),
    ...(client ? { client } : {}),
  });
  const text = await res.text();
  await Deno.writeTextFile(`/tmp/ibabs-probe-${SITENAME}-${op}.xml`, text);
  return text;
}

const all = (xml: string, tag: string) =>
  [...xml.matchAll(new RegExp(`<(?:[a-z]+:)?${tag}>([\\s\\S]*?)</(?:[a-z]+:)?${tag}>`, "g"))].map((m) => m[1]);
const one = (xml: string, tag: string) =>
  xml.match(new RegExp(`<(?:[a-z]+:)?${tag}>([^<]*)</(?:[a-z]+:)?${tag}>`))?.[1];

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

console.log(`[probe] sitename=${SITENAME} window=${MONTHS}mo proxy=${proxyUrl ?? "<none>"}`);

// 1. Meetings — confirm extractor-path data and look for inline vote signals.
const to = new Date();
const from = new Date(to);
from.setMonth(from.getMonth() - MONTHS);

console.log("\n== GetMeetingsByDateRange ==");
const meetingsXml = await soap(
  "GetMeetingsByDateRange",
  `<Sitename>${SITENAME}</Sitename><StartDate>${isoDate(from)}T00:00:00</StartDate><EndDate>${isoDate(to)}T23:59:59</EndDate><MetaDataOnly>false</MetaDataOnly>`,
);
const meetings = all(meetingsXml, "iBabsMeeting");
let itemsWithVoteCounts = 0;
let itemsWithListEntries = 0;
let meetingsWithListItems = 0;
for (const m of meetings) {
  if (/<(?:[a-z]+:)?ListItems>\s*<(?:[a-z]+:)?iBabsListItemSummary/.test(m)) meetingsWithListItems += 1;
  for (const item of all(m, "iBabsMeetingItem")) {
    const fa = one(item, "VotesInFavour");
    if (one(item, "HasVotes") === "true" || (fa && fa !== "0")) itemsWithVoteCounts += 1;
    if (/<(?:[a-z]+:)?iBabsListEntryBasic/.test(item)) itemsWithListEntries += 1;
  }
}
console.log(`  meetings: ${meetings.length}`);
console.log(`  with top-level ListItems: ${meetingsWithListItems}`);
console.log(`  agenda items w/ inline vote counts: ${itemsWithVoteCounts}`);
console.log(`  agenda items w/ MeetingItem.ListEntries: ${itemsWithListEntries}`);

// 2. Lists registry.
console.log("\n== GetLists ==");
const listsXml = await soap("GetLists", `<Sitename>${SITENAME}</Sitename>`);
const lists: { id: string; name: string }[] = [];
for (const kv of all(listsXml, "iBabsKeyValue")) {
  const id = one(kv, "Key");
  const name = one(kv, "Value");
  if (id && name) lists.push({ id, name });
}
console.log(`  lists: ${lists.length}`);
for (const l of lists) console.log(`    ${l.id}  ${l.name}`);

// 3. Pick promising lists and fetch entries + one detail per list.
const targets = lists.filter((l) => /motie|amendement|stemming|toezegging/i.test(l.name));
console.log(`\n== GetListsEntriesByFilterRequest (${targets.length} vote-related lists) ==`);
const sinceIso = `${isoDate(from)}T00:00:00`;
for (const l of targets) {
  const xml = await soap(
    "GetListsEntriesByFilterRequest",
    `<filterRequest xmlns:r="http://schemas.datacontract.org/2004/07/iBabsWCFObjects.Public.Request" xmlns:b="http://schemas.datacontract.org/2004/07/iBabsWCFObjects.Base"><b:Sitename>${SITENAME}</b:Sitename><r:ListId>${l.id}</r:ListId><r:SinceDate>${sinceIso}</r:SinceDate></filterRequest>`,
  );
  const entries = all(xml, "iBabsListEntryBase");
  const status = one(xml, "Status");
  console.log(`  [${l.name}] status=${status} entries=${entries.length}`);
  if (entries[0]) {
    const eid = one(entries[0], "EntryId")!;
    const title = one(entries[0], "EntryTitle");

    // Detail: rich Values + Documents
    const detailXml = await soap(
      "GetListEntry",
      `<Sitename>${SITENAME}</Sitename><ListId>${l.id}</ListId><EntryId>${eid}</EntryId>`,
    );
    const detailStatus = one(detailXml, "Status");
    const values = [...detailXml.matchAll(/<(?:[a-z]+:)?KeyValueOfstringstring>[\s\S]*?<(?:[a-z]+:)?Key>([^<]*)<\/(?:[a-z]+:)?Key>[\s\S]*?<(?:[a-z]+:)?Value>([^<]*)<\/(?:[a-z]+:)?Value>[\s\S]*?<\/(?:[a-z]+:)?KeyValueOfstringstring>/g)];
    const docs = all(detailXml, "iBabsDocument");
    console.log(`    sample entry: ${title?.slice(0, 60)}`);
    console.log(`    GetListEntry status=${detailStatus} values=${values.length} docs=${docs.length}`);
    for (const v of values.slice(0, 8)) console.log(`      ${v[1]} = ${v[2].slice(0, 80)}`);

    // Per-user votes (expected to be access-denied without credentials)
    const votesXml = await soap(
      "GetListEntryVotes",
      `<Sitename>${SITENAME}</Sitename><EntryId>${eid}</EntryId>`,
    );
    const vs = one(votesXml, "Status");
    const vm = one(votesXml, "Message");
    const vc = all(votesXml, "iBabsListEntryVote").length;
    console.log(`    GetListEntryVotes status=${vs} msg="${vm ?? ""}" votes=${vc}`);
  }
}
