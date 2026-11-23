import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import {
  COMMUNITY_MEMBER_JOINED,
  COMMUNITY_POST_CREATED,
  COMMUNITY_REPLY_CREATED,
  CommunityMemberJoinedEvent,
  CommunityPostCreatedEvent,
  CommunityReplyCreatedEvent,
} from '../communities/community.events';
import {
  EVENT_ATTENDEE_CHECKED_IN,
  EventAttendeeCheckedInEvent,
} from '../events/event.events';
import {
  VOLUNTEER_SESSION_COMPLETED,
  VolunteerSessionCompletedEvent,
} from '../volunteering/volunteering.events';
import { CommunityBadgeAwardingService } from './community-badge-awarding.service';

/** Resolves a community id from the slug a post event carries. */
export const COMMUNITY_ID_BY_SLUG_SQL = `SELECT "id" FROM "communities" WHERE "slug" = $1`;

/** Resolves the community an opportunity is attributed to. */
export const OPPORTUNITY_COMMUNITY_SQL = `SELECT "community_id" FROM "volunteer_opportunities" WHERE "id" = $1`;

/**
 * Event-driven trigger for community badge awards. Activity triggers (post,
 * reply, door check-in, volunteer completion) notify; a member joining is
 * evaluated silently so a rejoiner catches up on history without a bell.
 *
 * Every handler catches its own failures, so a badge failure can never break
 * the flow that emitted the event. Reply, check-in and join route through
 * `safeEvaluate`; post and volunteer completion resolve their community first,
 * inside their own try block. A failure log names the subject the handler
 * holds: the community id, the post's community slug or the opportunity id.
 */
@Injectable()
export class CommunityBadgeTriggersListener {
  private readonly logger = new Logger(CommunityBadgeTriggersListener.name);

  constructor(
    private readonly awarding: CommunityBadgeAwardingService,
    private readonly dataSource: DataSource,
  ) {}

  @OnEvent(COMMUNITY_POST_CREATED)
  async onPostCreated(event: CommunityPostCreatedEvent): Promise<void> {
    try {
      const rows: Array<{ id: string }> = await this.dataSource.query(
        COMMUNITY_ID_BY_SLUG_SQL,
        [event.communitySlug],
      );
      const communityId = rows[0]?.id;
      if (!communityId) {
        return;
      }
      await this.awarding.evaluateMember({
        communityId,
        userId: event.authorId,
        shouldNotify: true,
      });
    } catch (error) {
      this.logFailure(event.communitySlug, error);
    }
  }

  @OnEvent(COMMUNITY_REPLY_CREATED)
  async onReplyCreated(event: CommunityReplyCreatedEvent): Promise<void> {
    await this.safeEvaluate({
      communityId: event.communityId,
      userId: event.authorId,
      shouldNotify: true,
    });
  }

  @OnEvent(EVENT_ATTENDEE_CHECKED_IN)
  async onAttendeeCheckedIn(event: EventAttendeeCheckedInEvent): Promise<void> {
    if (event.communityId === null) {
      return;
    }
    await this.safeEvaluate({
      communityId: event.communityId,
      userId: event.userId,
      shouldNotify: true,
    });
  }

  @OnEvent(VOLUNTEER_SESSION_COMPLETED)
  async onVolunteerSessionCompleted(
    event: VolunteerSessionCompletedEvent,
  ): Promise<void> {
    if (!event.attended) {
      return;
    }
    try {
      const rows: Array<{ community_id: string | null }> =
        await this.dataSource.query(OPPORTUNITY_COMMUNITY_SQL, [
          event.opportunityId,
        ]);
      const communityId = rows[0]?.community_id ?? null;
      if (communityId === null) {
        return;
      }
      await this.awarding.evaluateMember({
        communityId,
        userId: event.volunteerId,
        shouldNotify: true,
      });
    } catch (error) {
      this.logFailure(event.opportunityId, error);
    }
  }

  @OnEvent(COMMUNITY_MEMBER_JOINED)
  async onMemberJoined(event: CommunityMemberJoinedEvent): Promise<void> {
    await this.safeEvaluate({
      communityId: event.communityId,
      userId: event.userId,
      shouldNotify: false,
    });
  }

  private async safeEvaluate(input: {
    communityId: string;
    userId: string;
    shouldNotify: boolean;
  }): Promise<void> {
    try {
      await this.awarding.evaluateMember(input);
    } catch (error) {
      this.logFailure(input.communityId, error);
    }
  }

  private logFailure(subjectId: string, error: unknown): void {
    const errorClass =
      error instanceof Error ? error.constructor.name : typeof error;
    this.logger.warn(
      `Community badge evaluation failed for subject ${subjectId}: ${errorClass}`,
    );
  }
}
