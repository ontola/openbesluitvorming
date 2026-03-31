import { NotubizClient } from "./client.ts";
import { buildEntityCommitEvent } from "../events/entity_commit.ts";
import { normalizeNotubizMeeting } from "./normalize.ts";
import type { EntityCommitEvent, MeetingEntity, NotubizSourceDefinition } from "../types.ts";

type NotubizEventsResponse = {
  events?: unknown[];
  pagination?: {
    has_more_pages?: boolean;
  };
};

type NotubizMeetingResponse = {
  meeting?: unknown;
};

export class NotubizMeetingExtractor {
  constructor(private readonly client = new NotubizClient()) {}

  async extractForDateRange(
    source: NotubizSourceDefinition,
    dateFrom: string,
    dateTo: string,
  ): Promise<MeetingEntity[]> {
    const organizationAttributes = await this.client.getOrganizationAttributes(
      source.notubizOrganizationId,
    );

    const meetings: MeetingEntity[] = [];
    let page = 1;

    while (true) {
      const eventPage = (await this.client.listEvents(
        source.notubizOrganizationId,
        dateFrom,
        dateTo,
        page,
      )) as NotubizEventsResponse;

      const events = Array.isArray(eventPage.events) ? eventPage.events : [];
      if (events.length === 0) {
        break;
      }

      for (const item of events) {
        if (!item || typeof item !== "object") continue;
        const eventRecord = item as Record<string, unknown>;
        if (eventRecord.permission_group !== "public") {
          continue;
        }

        const meetingId = eventRecord.id;
        if (typeof meetingId !== "number") {
          continue;
        }

        const meetingResponse = (await this.client.getMeeting(meetingId)) as NotubizMeetingResponse;
        if (!meetingResponse.meeting) {
          continue;
        }

        meetings.push(
          normalizeNotubizMeeting(source, organizationAttributes, meetingResponse.meeting),
        );
      }

      if (!eventPage.pagination?.has_more_pages) {
        break;
      }

      page += 1;
    }

    return meetings;
  }

  async extractCommitEventsForDateRange(
    source: NotubizSourceDefinition,
    dateFrom: string,
    dateTo: string,
  ): Promise<Array<EntityCommitEvent<MeetingEntity>>> {
    const meetings = await this.extractForDateRange(source, dateFrom, dateTo);
    return await Promise.all(meetings.map((meeting) => buildEntityCommitEvent(meeting)));
  }
}
