import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { runWithConcurrency } from '../common/run-with-concurrency';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { SubprofileFollower } from '../subprofiles/entities/subprofile-follower.entity';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import {
  Subprofile,
  SubprofileStatus,
  SubprofileVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { isSubprofileUnderTakedown } from '../subprofiles/subprofile-takedown';
import { SubprofilePost } from './entities/subprofile-post.entity';
import { personaPostExcerpt } from './persona-post.constants';

/** The fan-out bounds `SubprofileUpdatesService` uses: a cap far above any
 *  real audience, one multi-row insert per chunk, three chunks in flight. */
const POST_ALERT_MAX_RECIPIENTS = 5000;
const POST_ALERT_CHUNK_SIZE = 500;
const POST_ALERT_MAX_CONCURRENT_CHUNKS = 3;

/**
 * Studio v3: "a persona you follow posted an update". Shaped like
 * `SubprofileUpdatesService.notifyFollowersOfNewItems`: sent only while the
 * persona is published, open, present and clear of a moderator takedown,
 * to its followers minus its own creator and co-owners, through
 * `NotificationsService.createForRecipients` (block, mute and the
 * `persona_follows` preference filtered inside). The persona owner's id is
 * passed for block and mute filtering only; the payload names the persona
 * and never a member. The caller decides the three-a-day throttle.
 *
 * Best effort and post-commit: nothing here throws back at the post.
 */
@Injectable()
export class PersonaPostAlertsService {
  private readonly logger = new Logger(PersonaPostAlertsService.name);

  constructor(
    @InjectRepository(SubprofileFollower)
    private readonly followers: Repository<SubprofileFollower>,
    @InjectRepository(SubprofileMember)
    private readonly members: Repository<SubprofileMember>,
    private readonly notifications: NotificationsService,
    private readonly contentModeration: ContentModerationService,
  ) {}

  async alertFollowers(
    persona: Subprofile,
    post: SubprofilePost,
  ): Promise<void> {
    try {
      if (
        persona.status !== SubprofileStatus.Published ||
        persona.visibility !== SubprofileVisibility.Open ||
        persona.removedAt
      ) {
        return;
      }
      if (await isSubprofileUnderTakedown(this.contentModeration, persona.id)) {
        return;
      }
      const recipientIds = await this.recipientIdsFor(persona);
      if (!recipientIds.length) {
        return;
      }
      const linkToken = persona.handle ?? persona.slug;
      const payload = {
        subprofileName: persona.displayName.trim() || linkToken,
        subprofileSlugOrHandle: linkToken,
        subprofileId: persona.id,
        postId: post.id,
        excerpt: personaPostExcerpt(post.body),
      };
      const chunkThunks: Array<() => Promise<string[]>> = [];
      for (
        let offset = 0;
        offset < recipientIds.length;
        offset += POST_ALERT_CHUNK_SIZE
      ) {
        const chunk = recipientIds.slice(
          offset,
          offset + POST_ALERT_CHUNK_SIZE,
        );
        chunkThunks.push(() =>
          this.notifications.createForRecipients(
            chunk,
            NotificationType.PersonaPost,
            payload,
            persona.userId,
          ),
        );
      }
      await runWithConcurrency(chunkThunks, POST_ALERT_MAX_CONCURRENT_CHUNKS);
    } catch (error) {
      this.logger.warn(
        `Persona post alert failed for ${post.id}: ${String(error)}`,
      );
    }
  }

  private async recipientIdsFor(persona: Subprofile): Promise<string[]> {
    const followerRows = await this.followers.find({
      where: { subprofileId: persona.id },
      select: { followerId: true },
      order: { createdAt: 'ASC', id: 'ASC' },
      take: POST_ALERT_MAX_RECIPIENTS,
    });
    if (!followerRows.length) {
      return [];
    }
    const followerIds = followerRows.map((row) => row.followerId);
    const rosterRows = await this.members.find({
      where: { subprofileId: persona.id, userId: In(followerIds) },
      select: { userId: true },
    });
    const rosterIds = new Set(rosterRows.map((row) => row.userId));
    return followerIds.filter(
      (followerId) =>
        followerId !== persona.userId && !rosterIds.has(followerId),
    );
  }
}
