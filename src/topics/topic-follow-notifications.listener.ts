import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  TOPIC_POST_LINKED,
  TopicPostLinkedEvent,
} from '../content/topic.events';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { TopicFollow } from './entities/topic-follow.entity';

/**
 * DISC-3: the topic-follow fan-out analog of
 * `HousingSavedSearchAlertsListener`. When a forum thread's tag links a new
 * `topic_post` (`TopicPostLinkService`, content module, DISC-5), it tells every
 * member who follows that topic through the EXISTING notifications system
 * (`NotificationsService.createForRecipients`), the one delivery path.
 * Before this, "Follow topic" was fully wired end-to-end (real entity, real
 * toggle, `useTopics.ts`) but had zero downstream effect.
 *
 * BLOCK/MUTE: applies via `event.authorId` passed as `createForRecipients`'s
 * `actorId` argument, exactly like every other member-driven fan-out
 * (`MentionNotificationService.notify`, `NotificationsListener`). That argument
 * is passed even for a masked author (`event.isAuthorMasked`), whose id stays
 * out of the stored payload so no recipient can see who wrote the thread.
 *
 * PREFERENCE GATING: no dedicated `NotificationPreferenceCategory` exists for
 * "new post in a topic I follow". `CommunityReplies` governs REPLIES to a
 * thread you're already in (a different axis), and the settings pane's own
 * "new post in a community" toggle is still `comingSoon`/unwired
 * (`SettingsPanes.tsx`) for the exact same reason: no notification type backs
 * it yet. So this type follows the `HousingListingMatch` precedent and stays
 * off any mismatched existing toggle: the FOLLOW itself is the member's
 * consent (they opted into this specific topic), so no additional preference
 * toggle gates it here. Block/mute above still fully applies.
 */
@Injectable()
export class TopicFollowNotificationsListener {
  private readonly logger = new Logger(TopicFollowNotificationsListener.name);

  constructor(
    @InjectRepository(TopicFollow)
    private readonly follows: Repository<TopicFollow>,
    private readonly notifications: NotificationsService,
  ) {}

  @OnEvent(TOPIC_POST_LINKED)
  async onTopicPostLinked(event: TopicPostLinkedEvent): Promise<void> {
    try {
      const followerRows = await this.follows.find({
        where: { topicSlug: event.topicSlug },
        select: { userId: true },
      });
      // A null `authorId` (erased author, ENG-494) matches no follower, so
      // every follower hears about the thread.
      const recipientIds = followerRows
        .map((row) => row.userId)
        .filter((userId) => userId !== event.authorId);
      if (!recipientIds.length) return;

      // `source: 'forum'` + `threadSlug` reuses the SAME deep-link shape
      // `MentionNotificationService`/`ForumThreadsService` already write
      // (`sourceHrefFromPayload` on the frontend), so this row deep-links to
      // the thread with no new frontend routing needed.
      await this.notifications.createForRecipients(
        recipientIds,
        NotificationType.TopicNewPost,
        {
          // A masked byline (anonymous or official thread) keeps the writer
          // off the bell and the push: both read the actor from `actorId`
          // alone, so leaving it out is what hides them. An erased author has
          // no actor to show at all.
          ...(event.isAuthorMasked || event.authorId === null
            ? {}
            : { actorId: event.authorId }),
          source: 'forum',
          topicSlug: event.topicSlug,
          topicLabel: event.topicLabel,
          threadSlug: event.threadSlug,
          threadTitle: event.threadTitle,
        },
        // Block and mute filtering only; never rendered to a recipient. An
        // erased author blocks and mutes nobody, so there is nothing to apply.
        event.authorId ?? undefined,
      );
    } catch (error) {
      this.logger.warn(`Topic follow notification failed: ${String(error)}`);
    }
  }
}
