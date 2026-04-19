import { XMLParser } from "npm:fast-xml-parser";
import { setDefaultResultOrder } from "node:dns";
import type {
  DocumentEntity,
  IbabsDocument,
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
    message.includes("error reading a body from connection")
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

function soapEnvelope(operation: string, params: Record<string, string>): string {
  const paramXml = Object.entries(params)
    .map(([key, value]) => `<${key}>${value}</${key}>`)
    .join("");

  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <${operation} xmlns="http://tempuri.org/">
      ${paramXml}
    </${operation}>
  </s:Body>
</s:Envelope>`;
}

// iBabs occasionally holds a connection open without responding. Without an
// explicit timeout the fetch hangs indefinitely, and a single bad SOAP call
// wedges an ingest slot for hours. 90s is well above normal response time
// (observed p99 under 20s) but short enough that we bail and retry instead
// of hanging a slot for an entire batch.
const SOAP_TIMEOUT_MS = 90_000;

async function fetchText(url: string, init: RequestInit): Promise<string> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const client = getProxyClient();
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(SOAP_TIMEOUT_MS),
        ...(client ? { client } : {}),
      });
      if (!response.ok) {
        throw new Error(`Request failed ${response.status} for ${url}`);
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt === MAX_RETRIES || !isRetryableError(error)) {
        throw error;
      }
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Request failed for ${url}`);
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

  async downloadDocument(document: DocumentEntity): Promise<Uint8Array> {
    if (!document.original_url) {
      throw new Error("Document has no download URL");
    }

    const client = getProxyClient();
    const response = await fetch(document.original_url, {
      headers: {
        accept: "*/*",
        "user-agent": "woozi/0.1",
      },
      ...(client ? { client } : {}),
    });
    if (!response.ok) {
      throw new Error(`Request failed ${response.status} for ${document.original_url}`);
    }

    return new Uint8Array(await response.arrayBuffer());
  }
}

export const __test__ = {
  parseMeetingTypesXml,
  parseMeetingsXml,
};
