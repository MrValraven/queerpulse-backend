import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  TopicFollowsResponse,
  toTopicFollowsResponse,
} from './dto/topic-follows-response';
import { TopicFollow } from './entities/topic-follow.entity';

/**
 * Hard ceiling on how many topics one member can follow (BE-COM-35). There is
 * no topics table to bound the slug space against, so without a cap a single
 * member could accumulate unbounded rows — every one of which `listFollows`
 * returns to the client on every page load. Set far above any plausible real
 * use of the topics directory, so this only ever fires on abuse.
 */
const MAX_TOPIC_FOLLOWS = 200;

/**
 * Topic follows (P2-15). Topics are frontend-derived by slug, so a follow is a
 * thin `(user, topicSlug)` join — no FK to a topics table. Every method is
 * owner-scoped: the caller's `userId` is the only user any row is written or
 * read for.
 */
@Injectable()
export class TopicFollowsService {
  constructor(
    @InjectRepository(TopicFollow)
    private readonly follows: Repository<TopicFollow>,
  ) {}

  /**
   * Follow a topic for the caller. Idempotent: a second follow of the same slug
   * is absorbed by `ON CONFLICT DO NOTHING` against `UQ_topic_follows`, so
   * concurrent double-taps never 23505 — the endpoint always reports the
   * resulting "is following" truth.
   */
  async follow(userId: string, slug: string): Promise<{ following: true }> {
    // Checked before the insert and only for a slug the caller isn't already
    // following, so re-following stays the idempotent no-op documented above
    // even once the member is at the cap. The count/insert pair is not
    // transactional: this is an abuse ceiling, not an invariant, and a
    // concurrent double-tap landing one row over it is harmless.
    const isAlreadyFollowing = await this.follows.exists({
      where: { userId, topicSlug: slug },
    });
    if (!isAlreadyFollowing) {
      const followCount = await this.follows.count({ where: { userId } });
      if (followCount >= MAX_TOPIC_FOLLOWS) {
        throw new ConflictException(
          `You can follow up to ${MAX_TOPIC_FOLLOWS} topics. Unfollow one to make room.`,
        );
      }
    }

    await this.follows
      .createQueryBuilder()
      .insert()
      .into(TopicFollow)
      .values({ userId, topicSlug: slug })
      .orIgnore()
      .execute();
    return { following: true };
  }

  /**
   * Unfollow a topic. Idempotent: removing a follow that isn't there is a no-op
   * that still reports the same final state (no 404 — topics have no table to
   * validate the slug against, and an unknown slug simply follows/unfollows
   * nothing).
   */
  async unfollow(userId: string, slug: string): Promise<{ following: false }> {
    await this.follows.delete({ userId, topicSlug: slug });
    return { following: false };
  }

  /**
   * The caller's followed topic slugs, most-recently-followed first. One
   * indexed read on `topic_follows` (`user_id` leading), hand-mapped to the
   * slug array the frontend seeds its follow buttons from.
   */
  async listFollows(userId: string): Promise<TopicFollowsResponse> {
    const rows = await this.follows.find({
      where: { userId },
      select: { topicSlug: true },
      order: { createdAt: 'DESC' },
      // Belt and braces alongside `MAX_TOPIC_FOLLOWS` on the write path: rows
      // predating the cap can exceed it, and this read must stay bounded.
      take: MAX_TOPIC_FOLLOWS,
    });
    return toTopicFollowsResponse(rows);
  }
}
