import { assertEquals } from "jsr:@std/assert";
import { normalizeNotubizMeeting } from "../src/notubiz/normalize.ts";
import { compactEntityPayload } from "../src/quickwit/project.ts";
import { getNotubizSource } from "../src/sources/index.ts";
import type { NotubizOrganizationAttributes } from "../src/types.ts";
import { __test__ } from "../web/search_api.ts";

const { entitySourceUrl } = __test__;
type Hit = Parameters<typeof entitySourceUrl>[0];

Deno.test("a Notubiz meeting keeps its portal page and it survives compaction (#340)", async () => {
  const source = getNotubizSource("haarlem");
  const attributes = JSON.parse(
    await Deno.readTextFile(new URL("./fixtures/notubiz_haarlem_attributes.json", import.meta.url)),
  ) as NotubizOrganizationAttributes;
  const rawMeeting = JSON.parse(
    await Deno.readTextFile(new URL("./fixtures/notubiz_haarlem_meeting.json", import.meta.url)),
  );
  const portal = "https://gemeentebestuur-haarlem.notubiz.nl/vergadering/123/Raad";
  (rawMeeting.meeting ?? rawMeeting).url = portal;

  const meeting = normalizeNotubizMeeting(source, attributes, rawMeeting);
  assertEquals(meeting.source_url, portal);
  assertEquals((compactEntityPayload(meeting) as { source_url?: string }).source_url, portal);
});

Deno.test("an iBabs meeting links to its page on the iBabs portal", () => {
  const hit = { entity_type: "Meeting", source_key: "provincie_limburg", payload: {} } as Hit;
  assertEquals(
    entitySourceUrl(hit, "meeting:ibabs:provincie:limburg:eb84e011-fee8-4eb4-a766-48fd1604600d"),
    "https://limburg.bestuurlijkeinformatie.nl/Agenda/Index/eb84e011-fee8-4eb4-a766-48fd1604600d",
  );
});

Deno.test("a stored portal page wins, a document links to its file, other types to nothing", () => {
  assertEquals(
    entitySourceUrl(
      {
        entity_type: "Meeting",
        source_key: "haarlem",
        payload: { source_url: "https://example.notubiz.nl/vergadering/1" },
      } as Hit,
      "meeting:notubiz:gemeente:haarlem:1",
    ),
    "https://example.notubiz.nl/vergadering/1",
  );
  assertEquals(
    entitySourceUrl(
      {
        entity_type: "Document",
        payload: { original_url: "https://api.notubiz.nl/document/1/2" },
      } as Hit,
      "document:notubiz:gemeente:haarlem:1",
    ),
    "https://api.notubiz.nl/document/1/2",
  );
  assertEquals(
    entitySourceUrl({ entity_type: "Motion", payload: {} } as Hit, "motion:x"),
    undefined,
  );
  assertEquals(
    entitySourceUrl({ entity_type: "Meeting", source_key: "no_such_source" } as Hit, "meeting:x:y"),
    undefined,
  );
});
