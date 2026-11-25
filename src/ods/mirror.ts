import {
  type OdsAgendapunt,
  OdsCursorRejectedError,
  type OdsFeedClient,
  type OdsFeedRecord,
  type OdsInformatieobject,
  type OdsResource,
  type OdsResourceType,
  type OdsVergadering,
  ODS_RESOURCE_TYPES,
} from "./feed.ts";
import { odsNativeId } from "./normalize.ts";

/** The part of the object store the mirror needs. The real one is
 * `ObjectStorageClient`; tests pass a map. */
export interface MirrorStorage {
  putObject(key: string, body: Uint8Array, options?: { contentType?: string }): Promise<unknown>;
  getObjectText(key: string): Promise<string>;
  listObjects(options: {
    prefix?: string;
    startAfter?: string;
    maxKeys?: number;
  }): Promise<{ keys: string[]; isTruncated: boolean }>;
  deleteObjects(keys: string[]): Promise<void>;
}

/** Where we are in a source's feed. */
export interface MirrorState {
  /** The cursor for the next `GET /feed`. Absent until the snapshot is done. */
  cursor?: string;
  /** A snapshot in progress: the feed cursor of its first page, and where
   * the next snapshot page starts. */
  snapshot?: { feedCursor: string; next?: string };
  head?: number;
  lastSequenceNumber?: number;
  syncedAt?: string;
  /** Vergaderingen (bronidentificatie) changed by the feed and not yet
   * imported. Cleared by `acknowledgeImported` after a run emitted them, so a
   * run that fails after syncing does not lose them. */
  pendingMeetings?: string[];
}

export interface StoredResource<T extends OdsResource = OdsResource> {
  sequenceNumber: number;
  contentHash?: string;
  storedAt: string;
  data: T;
}

/** A resource the feed deleted or redacted. Kept until its retraction from
 * search and from our own export feed is done. */
export interface Removal {
  resourceType: OdsResourceType;
  bronidentificatie: string;
  op: "delete" | "redact";
  sequenceNumber: number;
  verwijderreden?: string;
  /** The vergaderingen it belonged to, for the meeting id of the tombstone. */
  meetings: string[];
  retracted: boolean;
}

export interface MirrorIndex {
  vergaderingen: Map<string, OdsVergadering>;
  agendapunten: Map<string, OdsAgendapunt>;
  informatieobjecten: Map<string, OdsInformatieobject>;
}

export interface SyncResult {
  /** Records applied in this sync. */
  applied: number;
  /** Whether this sync read (part of) the snapshot. */
  snapshot: boolean;
  head?: number;
}

const MAX_PAGES_PER_SYNC = 200;

function typeOf(value: string): OdsResourceType | undefined {
  return ODS_RESOURCE_TYPES.find((type) => type === value);
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** Our copy of one source's feed in object storage: the latest state of
 * every resource, the removals still to retract, and the cursor.
 *
 * The feed is the source of truth, and this copy is what the extractor reads,
 * like a supplier API for the polled sources. A full import replays it
 * without asking the feed again, and a better mapping later needs no new
 * snapshot. Each page is written before its cursor is saved, so a crash in
 * between replays that page, and replaying is harmless: a record that is not
 * newer than what we hold is skipped.
 *
 * Every resource is one object, and building the index lists them all. That
 * is right for the size of an OpenMeeting council; a feed with hundreds of
 * thousands of resources would want a compacted index instead. */
export class OdsMirror {
  constructor(
    private readonly storage: MirrorStorage,
    private readonly sourceKey: string,
  ) {}

  private get root(): string {
    return `ods/${this.sourceKey}/`;
  }

  private async resourceKey(type: OdsResourceType, bronidentificatie: string): Promise<string> {
    return `${this.root}resources/${type}/${await odsNativeId(bronidentificatie)}.json`;
  }

  private async removalKey(type: OdsResourceType, bronidentificatie: string): Promise<string> {
    return `${this.root}removed/${type}/${await odsNativeId(bronidentificatie)}.json`;
  }

  async state(): Promise<MirrorState> {
    const text = await this.storage.getObjectText(`${this.root}state.json`);
    return text ? (JSON.parse(text) as MirrorState) : {};
  }

  private async saveState(state: MirrorState): Promise<void> {
    await this.storage.putObject(`${this.root}state.json`, encode(state), {
      contentType: "application/json",
    });
  }

  async get<T extends OdsResource>(
    type: OdsResourceType,
    bronidentificatie: string,
  ): Promise<StoredResource<T> | undefined> {
    const text = await this.storage.getObjectText(await this.resourceKey(type, bronidentificatie));
    return text ? (JSON.parse(text) as StoredResource<T>) : undefined;
  }

  /** Read the feed until it has nothing more, or for at most
   * MAX_PAGES_PER_SYNC pages; the next sync goes on from there. Starts with
   * the snapshot when we have no cursor, and again when the feed refuses
   * ours. */
  async sync(client: OdsFeedClient): Promise<SyncResult> {
    let state = await this.state();
    const result: SyncResult = { applied: 0, snapshot: false };

    for (let page = 0; page < MAX_PAGES_PER_SYNC; page++) {
      if (!state.cursor) {
        result.snapshot = true;
        const snapshot = await client.snapshot(state.snapshot?.next);
        // The feed cursor of the first page is the one to continue from: it
        // was fixed before the snapshot rows were read.
        const feedCursor = state.snapshot?.feedCursor ?? snapshot.feedCursor;
        state = { ...state, pendingMeetings: await this.apply(snapshot.records, state) };
        result.applied += snapshot.records.length;
        state.snapshot =
          snapshot.hasMore && snapshot.cursor ? { feedCursor, next: snapshot.cursor } : undefined;
        if (!state.snapshot) {
          state.cursor = feedCursor;
        }
        state.syncedAt = new Date().toISOString();
        await this.saveState(state);
        continue;
      }

      let feed;
      try {
        feed = await client.feed(state.cursor);
      } catch (error) {
        if (error instanceof OdsCursorRejectedError) {
          // Start over from the snapshot. What we hold stays: the snapshot's
          // upserts replace it, and a resource that is gone by now is
          // reported by the weekly coverage check rather than guessed at.
          state = { ...state, cursor: undefined, snapshot: undefined };
          await this.saveState(state);
          continue;
        }
        throw error;
      }
      state = { ...state, pendingMeetings: await this.apply(feed.records, state) };
      result.applied += feed.records.length;
      state.cursor = feed.cursor;
      state.head = feed.head;
      result.head = feed.head;
      state.syncedAt = new Date().toISOString();
      await this.saveState(state);
      if (!feed.hasMore) break;
    }
    return result;
  }

  /** Apply records in feed order; returns the pending meetings with the ones
   * they touch added. */
  private async apply(records: OdsFeedRecord[], state: MirrorState): Promise<string[]> {
    const pending = new Set(state.pendingMeetings ?? []);
    for (const record of records) {
      const type = typeOf(record.resourceType);
      const bron = record.resource?.bronidentificatie;
      // A type we do not read yet (AanwezigeDeelnemer) or a record without a
      // key: skipped, not an error, so the feed can grow without breaking us.
      if (!type || !bron) continue;
      const previous = await this.get(type, bron);
      if (previous && previous.sequenceNumber >= record.sequenceNumber) continue;
      if (record.op === "upsert") {
        if (!record.data) continue;
        if (previous && record.contentHash && previous.contentHash === record.contentHash) {
          continue;
        }
        // Where it was, and where it is now: a moved agendapunt changes both.
        for (const meeting of await this.meetingsOf(type, previous?.data)) pending.add(meeting);
        const stored: StoredResource = {
          sequenceNumber: record.sequenceNumber,
          contentHash: record.contentHash,
          storedAt: record.storedAt,
          data: record.data,
        };
        await this.storage.putObject(await this.resourceKey(type, bron), encode(stored), {
          contentType: "application/json",
        });
        for (const meeting of await this.meetingsOf(type, record.data)) pending.add(meeting);
        // Published again after a delete: nothing left to retract.
        await this.storage.deleteObjects([await this.removalKey(type, bron)]);
      } else if (record.op === "delete" || record.op === "redact") {
        const meetings = await this.meetingsOf(type, previous?.data);
        const removal: Removal = {
          resourceType: type,
          bronidentificatie: bron,
          op: record.op,
          sequenceNumber: record.sequenceNumber,
          verwijderreden: record.verwijderreden,
          meetings,
          retracted: false,
        };
        await this.storage.putObject(await this.removalKey(type, bron), encode(removal), {
          contentType: "application/json",
        });
        await this.storage.deleteObjects([await this.resourceKey(type, bron)]);
        // A deleted vergadering is retracted, not re-imported; the meeting of
        // a deleted agendapunt or informatieobject is imported again without it.
        if (type === "Vergadering") pending.delete(bron);
        else for (const meeting of meetings) pending.add(meeting);
      }
    }
    return [...pending];
  }

  /** The vergaderingen a resource belongs to. */
  private async meetingsOf(
    type: OdsResourceType,
    data: OdsResource | undefined,
  ): Promise<string[]> {
    if (!data) return [];
    if (type === "Vergadering") return [data.bronidentificatie];
    if (type === "Agendapunt") {
      const bron = (data as OdsAgendapunt).vergadering?.bronidentificatie;
      return bron ? [bron] : [];
    }
    const doc = data as OdsInformatieobject;
    const meetings = new Set((doc.vergaderingen ?? []).map((ref) => ref.bronidentificatie));
    for (const ref of doc.agendapunten ?? []) {
      const item = await this.get<OdsAgendapunt>("Agendapunt", ref.bronidentificatie);
      const bron = item?.data.vergadering?.bronidentificatie;
      if (bron) meetings.add(bron);
    }
    return [...meetings];
  }

  /** Every resource we hold, by type. */
  async index(): Promise<MirrorIndex> {
    const index: MirrorIndex = {
      vergaderingen: new Map(),
      agendapunten: new Map(),
      informatieobjecten: new Map(),
    };
    for (const type of ODS_RESOURCE_TYPES) {
      for await (const text of this.readAll(`${this.root}resources/${type}/`)) {
        const stored = JSON.parse(text) as StoredResource;
        const bron = stored.data.bronidentificatie;
        if (type === "Vergadering") index.vergaderingen.set(bron, stored.data as OdsVergadering);
        if (type === "Agendapunt") index.agendapunten.set(bron, stored.data as OdsAgendapunt);
        if (type === "Informatieobject") {
          index.informatieobjecten.set(bron, stored.data as OdsInformatieobject);
        }
      }
    }
    return index;
  }

  /** Removals not yet retracted. */
  async pendingRemovals(): Promise<Removal[]> {
    const removals: Removal[] = [];
    for await (const text of this.readAll(`${this.root}removed/`)) {
      const removal = JSON.parse(text) as Removal;
      if (!removal.retracted) removals.push(removal);
    }
    return removals;
  }

  async markRetracted(removal: Removal): Promise<void> {
    await this.storage.putObject(
      await this.removalKey(removal.resourceType, removal.bronidentificatie),
      encode({ ...removal, retracted: true }),
      { contentType: "application/json" },
    );
  }

  /** The run emitted these meetings; take them off the pending list. Reads
   * the state again, so meetings a concurrent sync added stay. */
  async acknowledgeImported(meetings: Iterable<string>): Promise<void> {
    const done = new Set(meetings);
    if (done.size === 0) return;
    const state = await this.state();
    const pending = (state.pendingMeetings ?? []).filter((bron) => !done.has(bron));
    await this.saveState({ ...state, pendingMeetings: pending });
  }

  private async *readAll(prefix: string): AsyncGenerator<string> {
    let startAfter: string | undefined;
    while (true) {
      const page = await this.storage.listObjects({ prefix, startAfter, maxKeys: 1000 });
      for (const key of page.keys) {
        const text = await this.storage.getObjectText(key);
        if (text) yield text;
      }
      if (!page.isTruncated || page.keys.length === 0) return;
      startAfter = page.keys.at(-1);
    }
  }
}
