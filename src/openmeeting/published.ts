import type { PublishedMeeting } from "./normalize.ts";
import { openMeetingNativeId } from "./normalize.ts";

/** The part of the object store the published meetings need. The real one is
 * `ObjectStorageClient`; tests pass a map. */
export interface PublishedStorage {
  putObject(key: string, body: Uint8Array, options?: { contentType?: string }): Promise<unknown>;
  getObjectText(key: string): Promise<string>;
  listObjects(options: {
    prefix?: string;
    startAfter?: string;
    maxKeys?: number;
  }): Promise<{ keys: string[]; isTruncated: boolean }>;
  deleteObjects(keys: string[]): Promise<void>;
}

/** Meetings an OpenMeeting council published, one JSON object per meeting,
 * as they arrived. The store is to a pushing source what the supplier API is
 * to a polled one: what the extractor reads, and what a full import replays.
 * It is kept for the same reason we keep original PDFs: a better mapping
 * later does not need the council to publish again. */
export class PublishedMeetings {
  constructor(private readonly storage: PublishedStorage) {}

  static prefix(sourceKey: string): string {
    return `published/openmeeting/${sourceKey}/meetings/`;
  }

  static async keyFor(sourceKey: string, meetingId: string): Promise<string> {
    return `${PublishedMeetings.prefix(sourceKey)}${await openMeetingNativeId(meetingId)}.json`;
  }

  async put(sourceKey: string, meeting: PublishedMeeting, receivedAt: Date): Promise<string> {
    const key = await PublishedMeetings.keyFor(sourceKey, meeting.id);
    const body = JSON.stringify({ received_at: receivedAt.toISOString(), meeting });
    await this.storage.putObject(key, new TextEncoder().encode(body), {
      contentType: "application/json",
    });
    return key;
  }

  /** Removes a meeting from the store. What was already imported stays in the
   * index until it is taken down; see API.md. */
  async remove(sourceKey: string, meetingId: string): Promise<boolean> {
    const key = await PublishedMeetings.keyFor(sourceKey, meetingId);
    const exists = (await this.storage.getObjectText(key)) !== "";
    if (exists) {
      await this.storage.deleteObjects([key]);
    }
    return exists;
  }

  async get(sourceKey: string, meetingId: string): Promise<PublishedMeeting | undefined> {
    const key = await PublishedMeetings.keyFor(sourceKey, meetingId);
    return parseStored(await this.storage.getObjectText(key));
  }

  /** Every meeting the source published, in key order. */
  async *list(sourceKey: string): AsyncGenerator<{ key: string; meeting: PublishedMeeting }> {
    const prefix = PublishedMeetings.prefix(sourceKey);
    let startAfter: string | undefined;
    while (true) {
      const page = await this.storage.listObjects({ prefix, startAfter, maxKeys: 1000 });
      for (const key of page.keys) {
        const meeting = parseStored(await this.storage.getObjectText(key));
        if (meeting) {
          yield { key, meeting };
        }
      }
      if (!page.isTruncated || page.keys.length === 0) {
        return;
      }
      startAfter = page.keys.at(-1);
    }
  }
}

function parseStored(text: string): PublishedMeeting | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { meeting?: PublishedMeeting };
    return parsed.meeting;
  } catch {
    return undefined;
  }
}

/** The Europe/Amsterdam calendar day of an instant: the day a meeting is on,
 * which is what an import window (`YYYY-MM-DD` to `YYYY-MM-DD`) means. */
export function amsterdamDay(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Amsterdam",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}
