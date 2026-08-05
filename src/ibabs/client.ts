import { XMLParser } from "npm:fast-xml-parser";
import { setDefaultResultOrder } from "node:dns";
import { ibabsRateLimiter } from "./rate_limit.ts";
import type {
  DocumentEntity,
  IbabsDocument,
  IbabsList,
  IbabsListEntryBase,
  IbabsListEntryDetail,
  IbabsListEntryVote,
  IbabsMeeting,
  IbabsMeetingItem,
  IbabsMeetingType,
  IbabsSourceDefinition,
  IbabsUserBasic,
} from "../types.ts";

// iBabs whitelists by IPv4 only; dual-stack hosts default to IPv6 which is
// silently rejected. Prefer IPv4 for DNS lookups so the production worker
// reaches the API over its whitelisted IPv4 address.
setDefaultResultOrder("ipv4first");

const DEFAULT_IBABS_URL = "https://wcf.ibabs.eu/api/Public.svc";
const SOAP_ACTION_PREFIX = "http://tempuri.org/IPublic/";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 300;
// iBabs throttles a burst of SOAP calls with HTTP 403 — measured 2026-07-31: a
// 4-way concurrent probe drew 403s after ~240 calls, while a single request
// straight afterwards succeeded. So at the transport layer a 403 is a rate
// limit, not an authorisation problem; genuine access denials come back as
// HTTP 200 with Status=ERR and are caught by assertIbabsResultOk.
//
// Throttles need seconds, not the sub-second transport retry: 300ms/600ms
// burns all three attempts inside a second and fails anyway. These get their
// own budget of ~30s total.
const THROTTLE_MAX_RETRIES = 4;
const throttleBaseDelayMs = Math.max(
  1,
  Number(Deno.env.get("WOOZI_IBABS_THROTTLE_BASE_MS") ?? "2000"),
);

/** An HTTP-level failure that kept its status code, so the retry policy can
 * tell a throttle apart from a hard error. */
class IbabsHttpError extends Error {
  constructor(
    readonly status: number,
    url: string,
    readonly retryAfterMs?: number,
  ) {
    // Message shape is unchanged: other layers match on it.
    super(`Request failed ${status} for ${url}`);
    this.name = "IbabsHttpError";
  }
}

function isThrottleError(error: unknown): error is IbabsHttpError {
  return error instanceof IbabsHttpError && (error.status === 429 || error.status === 403);
}

/** `Retry-After` in seconds. The HTTP-date form is ignored — iBabs has not been
 * seen using it, and guessing wrong is worse than falling back to the curve. */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

function throttleDelayMs(attempt: number, retryAfterMs?: number): number {
  return retryAfterMs ?? throttleBaseDelayMs * 2 ** (attempt - 1);
}

// When IBABS_PROXY_URL is set (e.g. http://localhost:8888), all iBabs
// requests are routed through this HTTP proxy. This allows local development
// to reach the iBabs API via the production server's whitelisted IP.
// Set up with: ssh -D 1080 -N root@<production-ip>
// Then: IBABS_PROXY_URL=socks5://localhost:1080
let proxyClient: Deno.HttpClient | undefined;
function getProxyClient(): Deno.HttpClient | undefined {
  if (proxyClient !== undefined) return proxyClient;
  const proxyUrl = Deno.env.get("IBABS_PROXY_URL")?.trim();
  if (proxyUrl) {
    proxyClient = Deno.createHttpClient({ proxy: { url: proxyUrl } });
  }
  return proxyClient;
}
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseTagValue: false,
  trimValues: true,
  processEntities: {
    enabled: true,
    maxTotalExpansions: 100000,
  },
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === "TimeoutError" || error.name === "AbortError") {
    return true;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("connection reset") ||
    message.includes("broken pipe") ||
    message.includes("timed out") ||
    message.includes("dns error") ||
    message.includes("client error") ||
    message.includes("error reading a body from connection") ||
    // Deno's wording when the connection cannot be established at all. Seen
    // 10 times in one motion run against iBabs; without this it was the only
    // transport failure that got no retry, and each one skipped a motion.
    message.includes("error sending request")
  );
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function valueForLocalName(record: unknown, localName: string): unknown {
  if (!record || typeof record !== "object") {
    return undefined;
  }

  for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
    const plainKey = key.includes(":") ? key.slice(key.indexOf(":") + 1) : key;
    if (plainKey === localName) {
      return value;
    }
  }

  return undefined;
}

function nestedValue(record: unknown, path: string[]): unknown {
  let current: unknown = record;
  for (const segment of path) {
    current = valueForLocalName(current, segment);
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

function textValue(record: unknown, localName: string): string | undefined {
  const value = valueForLocalName(record, localName);
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (
    value &&
    typeof value === "object" &&
    "#text" in value &&
    typeof (value as Record<string, unknown>)["#text"] === "string"
  ) {
    const text = (value as Record<string, unknown>)["#text"] as string;
    return text.length > 0 ? text : undefined;
  }

  return undefined;
}

function parseBoolean(value?: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return undefined;
}

function parseNumber(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function assertIbabsResultOk(result: unknown, context: string): void {
  const status = textValue(result, "Status");
  const message = textValue(result, "Message");

  if (status === "ERR") {
    throw new Error(message || `iBabs ${context} returned status ERR`);
  }

  if (message?.includes("has no access")) {
    throw new Error(message);
  }
}

function parseUsers(parent?: unknown): IbabsUserBasic[] {
  if (!parent) {
    return [];
  }

  return asArray(valueForLocalName(parent, "iBabsUserBasic"))
    .map((user) => ({
      UniqueId: textValue(user, "UniqueId") ?? "",
      Name: textValue(user, "Name"),
      Emailaddress: textValue(user, "Emailaddress"),
    }))
    .filter((user) => user.UniqueId.length > 0);
}

function parseDocuments(parent?: unknown): IbabsDocument[] {
  if (!parent) {
    return [];
  }

  return asArray(valueForLocalName(parent, "iBabsDocument"))
    .map((document) => ({
      Id: textValue(document, "Id") ?? "",
      FileName: textValue(document, "FileName"),
      DisplayName: textValue(document, "DisplayName"),
      Confidential: parseBoolean(textValue(document, "Confidential")),
      PublicDownloadURL: textValue(document, "PublicDownloadURL"),
      FileSize: parseNumber(textValue(document, "FileSize")),
    }))
    .filter((document) => document.Id.length > 0);
}

function parseMeetingItems(parent?: unknown): IbabsMeetingItem[] {
  if (!parent) {
    return [];
  }

  return asArray(valueForLocalName(parent, "iBabsMeetingItem"))
    .map((item) => ({
      Id: textValue(item, "Id") ?? "",
      Features: textValue(item, "Features"),
      Title: textValue(item, "Title"),
      Explanation: textValue(item, "Explanation"),
      Confidential: parseBoolean(textValue(item, "Confidential")),
      Documents: parseDocuments(valueForLocalName(item, "Documents")),
    }))
    .filter((item) => item.Id.length > 0);
}

function parseMeetingTypesXml(xml: string): IbabsMeetingType[] {
  const document = xmlParser.parse(xml);
  const result = nestedValue(document, [
    "Envelope",
    "Body",
    "GetMeetingtypesResponse",
    "GetMeetingtypesResult",
  ]);
  if (!result) {
    throw new Error("Invalid iBabs GetMeetingtypes response");
  }

  // Archived sites (e.g. municipalities merged into a new one) report
  // Status=ERR "No public meetingtypes!" while GetMeetingsByDateRange still
  // serves their full history. The map only feeds meeting-type labels, so
  // continue without it rather than failing the whole run.
  if (textValue(result, "Message")?.includes("No public meetingtypes")) {
    return [];
  }

  assertIbabsResultOk(result, "GetMeetingtypes");

  const meetingTypes = valueForLocalName(result, "Meetingtypes");
  if (!meetingTypes) {
    return [];
  }

  return asArray(valueForLocalName(meetingTypes, "iBabsMeetingtype"))
    .map((item) => ({
      Id: textValue(item, "Id") ?? "",
      Description: textValue(item, "Description"),
      Meetingtype: textValue(item, "Meetingtype"),
    }))
    .filter((item) => item.Id.length > 0);
}

function parseMeetingsXml(xml: string): IbabsMeeting[] {
  const document = xmlParser.parse(xml);
  const result = nestedValue(document, [
    "Envelope",
    "Body",
    "GetMeetingsByDateRangeResponse",
    "GetMeetingsByDateRangeResult",
  ]);
  if (!result) {
    throw new Error("Invalid iBabs GetMeetingsByDateRange response");
  }

  // iBabs reports an empty window as Status=ERR with this literal message.
  // That's a normal outcome, not a failure — deep-history backfill chunks hit
  // it constantly (sources digitized long after 2002) and each one was
  // wrongly counted as a failed run.
  if (textValue(result, "Message")?.includes("No public meetings")) {
    return [];
  }

  assertIbabsResultOk(result, "GetMeetingsByDateRange");

  const meetings = valueForLocalName(result, "Meetings");
  if (!meetings) {
    return [];
  }

  return asArray(valueForLocalName(meetings, "iBabsMeeting"))
    .map((meeting) => ({
      Id: textValue(meeting, "Id") ?? "",
      MeetingtypeId: textValue(meeting, "MeetingtypeId"),
      MeetingDate: textValue(meeting, "MeetingDate"),
      StartTime: textValue(meeting, "StartTime"),
      EndTime: textValue(meeting, "EndTime"),
      Location: textValue(meeting, "Location"),
      Chairman: textValue(meeting, "Chairman"),
      Explanation: textValue(meeting, "Explanation"),
      PublishDate: textValue(meeting, "PublishDate"),
      Invitees: parseUsers(valueForLocalName(meeting, "Invitees")),
      Attendees: parseUsers(valueForLocalName(meeting, "Attendees")),
      MeetingItems: parseMeetingItems(valueForLocalName(meeting, "MeetingItems")),
      Documents: parseDocuments(valueForLocalName(meeting, "Documents")),
    }))
    .filter((meeting) => meeting.Id.length > 0);
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function soapEnvelope(operation: string, params: Record<string, string>): string {
  const paramXml = Object.entries(params)
    .map(([key, value]) => `<${key}>${escapeXml(value)}</${key}>`)
    .join("");

  return soapEnvelopeRaw(operation, paramXml);
}

function soapEnvelopeRaw(operation: string, paramXml: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <${operation} xmlns="http://tempuri.org/">
      ${paramXml}
    </${operation}>
  </s:Body>
</s:Envelope>`;
}

function parseListsXml(xml: string): IbabsList[] {
  const document = xmlParser.parse(xml);
  const result = nestedValue(document, ["Envelope", "Body", "GetListsResponse", "GetListsResult"]);
  if (!result) {
    throw new Error("Invalid iBabs GetLists response");
  }

  // GetLists answers with a bare iBabsKeyValue array — no Status/Message
  // wrapper, unlike the other list operations. Don't assert on status here.
  return asArray(valueForLocalName(result, "iBabsKeyValue"))
    .map((pair) => ({
      ListId: textValue(pair, "Key") ?? "",
      ListName: textValue(pair, "Value") ?? "",
    }))
    .filter((list) => list.ListId.length > 0 && list.ListName.length > 0);
}

function parseListEntriesXml(xml: string): IbabsListEntryBase[] {
  const document = xmlParser.parse(xml);
  const result = nestedValue(document, [
    "Envelope",
    "Body",
    "GetListsEntriesByFilterRequestResponse",
    "GetListsEntriesByFilterRequestResult",
  ]);
  if (!result) {
    throw new Error("Invalid iBabs GetListsEntriesByFilterRequest response");
  }

  assertIbabsResultOk(result, "GetListsEntriesByFilterRequest");

  const entries = valueForLocalName(result, "Entries");
  if (!entries) {
    return [];
  }

  return asArray(valueForLocalName(entries, "iBabsListEntryBase"))
    .map((entry) => ({
      EntryId: textValue(entry, "EntryId") ?? "",
      EntryMasterId: textValue(entry, "EntryMasterId"),
      EntryTitle: textValue(entry, "EntryTitle"),
      ListId: textValue(entry, "ListId"),
      ListName: textValue(entry, "ListName"),
      ListCanVote: parseBoolean(textValue(entry, "ListCanVote")),
      MutationDate: textValue(entry, "MutationDate"),
    }))
    .filter((entry) => entry.EntryId.length > 0);
}

function parseListEntryXml(xml: string, entryId: string): IbabsListEntryDetail {
  const document = xmlParser.parse(xml);
  const result = nestedValue(document, [
    "Envelope",
    "Body",
    "GetListEntryResponse",
    "GetListEntryResult",
  ]);
  if (!result) {
    throw new Error("Invalid iBabs GetListEntry response");
  }

  assertIbabsResultOk(result, "GetListEntry");

  const values: Record<string, string> = {};
  const valuesNode = valueForLocalName(result, "Values");
  for (const pair of asArray(valueForLocalName(valuesNode, "KeyValueOfstringstring"))) {
    const key = textValue(pair, "Key");
    const value = textValue(pair, "Value");
    if (key && value !== undefined) {
      values[key] = value;
    }
  }

  return {
    EntryId: entryId,
    Values: values,
    Documents: parseDocuments(valueForLocalName(result, "Documents")),
  };
}

function parseListEntryVotesXml(xml: string): IbabsListEntryVote[] {
  const document = xmlParser.parse(xml);
  const result = nestedValue(document, [
    "Envelope",
    "Body",
    "GetListEntryVotesByListEntryIdResponse",
    "GetListEntryVotesByListEntryIdResult",
  ]);
  if (!result) {
    throw new Error("Invalid iBabs GetListEntryVotesByListEntryId response");
  }

  assertIbabsResultOk(result, "GetListEntryVotesByListEntryId");

  const votes = valueForLocalName(result, "ListEntryVotes");
  if (!votes) {
    return [];
  }

  return asArray(valueForLocalName(votes, "iBabsListEntryVote")).map((vote) => ({
    EntryId: textValue(vote, "EntryId"),
    GroupId: textValue(vote, "GroupId"),
    GroupName: textValue(vote, "GroupName"),
    UserId: textValue(vote, "UserId"),
    UserName: textValue(vote, "UserName"),
    Vote: parseBoolean(textValue(vote, "Vote")),
  }));
}

// iBabs occasionally holds a connection open without responding. Without an
// explicit timeout the fetch hangs indefinitely, and a single bad SOAP call
// wedges an ingest slot for hours. 90s is well above normal response time
// (observed p99 under 20s) but short enough that we bail and retry instead
// of hanging a slot for an entire batch.
const SOAP_TIMEOUT_MS = 90_000;

async function fetchText(url: string, init: RequestInit): Promise<string> {
  let lastError: unknown;
  // Two independent budgets. A throttle is not the same failure as a dropped
  // connection, and sharing one counter would let a couple of connection
  // resets eat the patience a rate limit needs.
  let transportAttempts = 0;
  let throttleAttempts = 0;

  const limiter = ibabsRateLimiter();

  while (true) {
    try {
      // Paced and gated fleet-wide: one worker meeting a 403 stops the rest
      // too, which per-connection backoff could never do.
      await limiter.acquire();
      const client = getProxyClient();
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(SOAP_TIMEOUT_MS),
        ...(client ? { client } : {}),
      });
      if (!response.ok) {
        const failure = new IbabsHttpError(
          response.status,
          url,
          parseRetryAfter(response.headers.get("retry-after")),
        );
        if (isThrottleError(failure)) {
          limiter.recordThrottle();
        }
        throw failure;
      }
      limiter.recordSuccess();
      return await response.text();
    } catch (error) {
      lastError = error;

      if (isThrottleError(error)) {
        throttleAttempts += 1;
        if (throttleAttempts > THROTTLE_MAX_RETRIES) {
          throw error;
        }
        console.log(
          `[ibabs] throttled ${error.status}, backing off ` +
            `${throttleDelayMs(throttleAttempts, error.retryAfterMs)}ms ` +
            `(attempt ${throttleAttempts}/${THROTTLE_MAX_RETRIES})`,
        );
        await sleep(throttleDelayMs(throttleAttempts, error.retryAfterMs));
        continue;
      }

      transportAttempts += 1;
      if (transportAttempts >= MAX_RETRIES || !isRetryableError(error)) {
        throw error;
      }
      await sleep(RETRY_DELAY_MS * transportAttempts);
    }
  }
}

export class IbabsClient {
  constructor(private readonly endpoint = Deno.env.get("IBABS_PUBLIC_URL") ?? DEFAULT_IBABS_URL) {}

  private async postSoap(operation: string, params: Record<string, string>): Promise<string> {
    return await fetchText(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "text/xml; charset=utf-8",
        soapaction: `"${SOAP_ACTION_PREFIX}${operation}"`,
        "user-agent": "woozi/0.1",
      },
      body: soapEnvelope(operation, params),
    });
  }

  async getMeetingTypes(source: IbabsSourceDefinition): Promise<IbabsMeetingType[]> {
    return parseMeetingTypesXml(
      await this.postSoap("GetMeetingtypes", {
        Sitename: source.ibabsSitename,
      }),
    );
  }

  async listMeetingsByDateRange(
    source: IbabsSourceDefinition,
    dateFrom: string,
    dateTo: string,
  ): Promise<IbabsMeeting[]> {
    return parseMeetingsXml(
      await this.postSoap("GetMeetingsByDateRange", {
        Sitename: source.ibabsSitename,
        StartDate: `${dateFrom}T00:00:00`,
        EndDate: `${dateTo}T23:59:59`,
        MetaDataOnly: "false",
      }),
    );
  }

  /** Registries for a site: moties, amendementen, toezeggingen, … */
  async getLists(source: IbabsSourceDefinition): Promise<IbabsList[]> {
    return parseListsXml(
      await this.postSoap("GetLists", {
        Sitename: source.ibabsSitename,
      }),
    );
  }

  /** Entries in one registry, changed on or after `sinceDate` (YYYY-MM-DD). */
  async listListEntries(
    source: IbabsSourceDefinition,
    listId: string,
    sinceDate: string,
  ): Promise<IbabsListEntryBase[]> {
    // This operation takes a single complex parameter whose children live in
    // two other namespaces, so it can't go through the flat key/value builder.
    const filterRequest =
      `<filterRequest xmlns:r="http://schemas.datacontract.org/2004/07/iBabsWCFObjects.Public.Request"` +
      ` xmlns:b="http://schemas.datacontract.org/2004/07/iBabsWCFObjects.Base">` +
      `<b:Sitename>${escapeXml(source.ibabsSitename)}</b:Sitename>` +
      `<r:ListId>${escapeXml(listId)}</r:ListId>` +
      `<r:SinceDate>${escapeXml(sinceDate)}T00:00:00</r:SinceDate>` +
      `</filterRequest>`;

    return parseListEntriesXml(
      await fetchText(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "text/xml; charset=utf-8",
          soapaction: `"${SOAP_ACTION_PREFIX}GetListsEntriesByFilterRequest"`,
          "user-agent": "woozi/0.1",
        },
        body: soapEnvelopeRaw("GetListsEntriesByFilterRequest", filterRequest),
      }),
    );
  }

  async getListEntry(
    source: IbabsSourceDefinition,
    listId: string,
    entryId: string,
  ): Promise<IbabsListEntryDetail> {
    return parseListEntryXml(
      await this.postSoap("GetListEntry", {
        Sitename: source.ibabsSitename,
        ListId: listId,
        EntryId: entryId,
      }),
      entryId,
    );
  }

  /** Per-member votes for one entry.
   *
   * Note the operation name says `ByListEntryId` but the parameter that works
   * is `EntryId`; passing `ListEntryId` fails with a misleading
   * "cast to value type 'System.Guid' failed" error. The similarly named
   * `GetListEntryVotes` is access-denied — this one is public.
   *
   * Returns an empty list for the roughly half of iBabs sources that don't use
   * the digital voting module. That is a normal outcome, not a failure. */
  async getListEntryVotes(
    source: IbabsSourceDefinition,
    entryId: string,
  ): Promise<IbabsListEntryVote[]> {
    return parseListEntryVotesXml(
      await this.postSoap("GetListEntryVotesByListEntryId", {
        Sitename: source.ibabsSitename,
        EntryId: entryId,
      }),
    );
  }

  async downloadDocument(document: DocumentEntity): Promise<Uint8Array> {
    if (!document.original_url) {
      throw new Error("Document has no download URL");
    }

    const limiter = ibabsRateLimiter();
    // Downloads go to api1.ibabs.eu rather than the SOAP host, but the block
    // that hit us on 2026-08-05 covered both — it is one IP budget.
    await limiter.acquire();
    const client = getProxyClient();
    // Same rationale as the SOAP fetch: an open but unresponsive connection
    // would otherwise wedge a document concurrency slot indefinitely.
    const response = await fetch(document.original_url, {
      signal: AbortSignal.timeout(SOAP_TIMEOUT_MS),
      headers: {
        accept: "*/*",
        "user-agent": "woozi/0.1",
      },
      ...(client ? { client } : {}),
    });
    if (!response.ok) {
      if (response.status === 403 || response.status === 429) {
        limiter.recordThrottle();
      }
      throw new Error(`Request failed ${response.status} for ${document.original_url}`);
    }
    limiter.recordSuccess();

    return new Uint8Array(await response.arrayBuffer());
  }
}

export const __test__ = {
  fetchText,
  isThrottleError,
  parseRetryAfter,
  throttleDelayMs,
  IbabsHttpError,
  parseMeetingTypesXml,
  parseMeetingsXml,
  parseListsXml,
  parseListEntriesXml,
  parseListEntryXml,
  parseListEntryVotesXml,
};
