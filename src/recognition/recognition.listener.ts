import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  COMMUNITY_POST_CREATED,
  CommunityPostCreatedEvent,
} from '../communities/community.events';
import {
  CONNECTION_ACCEPTED,
  ConnectionAcceptedEvent,
} from '../connections/connection.events';
import { EVENT_RSVPED, EventRsvpedEvent } from '../events/event.events';
import {
  FORUM_THREAD_CREATED,
  ForumThreadCreatedEvent,
} from '../forum/forum.events';
import { VOUCH_CREATED, VouchCreatedEvent } from '../vouch/vouch.events';
import { RecognitionAwardingService } from './recognition-awarding.service';

/**
 * Hybrid event-driven trigger for the recognition/XP engine. The on-read
 * recompute in `MyRecognitionController` (throttled to once per 5 minutes)
 * stays as the fallback: it is the only path that catches time-based badges
 * like decade/sustainer that have no triggering event. This listener ALSO
 * kicks a throttled recompute right after a high-signal action, so a
 * member's XP/badges/notifications update promptly instead of waiting for
 * their next `GET /me/recognition`.
 *
 * Every handler recomputes only the member(s) directly affected by that
 * event, and routes through `safeRecompute` so a recognition failure can
 * never break the emitting domain flow (vouching, connecting, RSVPing,
 * posting, starting a thread).
 */
@Injectable()
export class RecognitionListener {
  private readonly logger = new Logger(RecognitionListener.name);

  constructor(private readonly awarding: RecognitionAwardingService) {}

  @OnEvent(VOUCH_CREATED)
  async onVouchCreated(event: VouchCreatedEvent): Promise<void> {
    // Recompute the member who RECEIVED the vouch; vouchCount is their signal.
    await this.safeRecompute(event.voucheeId);
  }

  @OnEvent(CONNECTION_ACCEPTED)
  async onConnectionAccepted(event: ConnectionAcceptedEvent): Promise<void> {
    // connectionCount changes for both sides of the new connection.
    await Promise.all([
      this.safeRecompute(event.requesterId),
      this.safeRecompute(event.addresseeId),
    ]);
  }

  @OnEvent(EVENT_RSVPED)
  async onEventRsvped(event: EventRsvpedEvent): Promise<void> {
    await this.safeRecompute(event.rsvperId);
  }

  @OnEvent(COMMUNITY_POST_CREATED)
  async onCommunityPostCreated(
    event: CommunityPostCreatedEvent,
  ): Promise<void> {
    await this.safeRecompute(event.authorId);
  }

  @OnEvent(FORUM_THREAD_CREATED)
  async onForumThreadCreated(event: ForumThreadCreatedEvent): Promise<void> {
    await this.safeRecompute(event.authorId);
  }

  private async safeRecompute(userId: string): Promise<void> {
    try {
      await this.awarding.recomputeByUserId(userId);
    } catch (error) {
      this.logger.warn(
        `recognition recompute failed for ${userId}: ${String(error)}`,
      );
    }
  }
}
