import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  TopicFollowsResponse,
  toTopicFollowsResponse,
} from './dto/topic-follows-response';
import { TopicFollow } from './entities/topic-follow.entity';

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
    });
    return toTopicFollowsResponse(rows);
  }
}
