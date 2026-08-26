import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  CommunityPostReaction,
  ReactionKey,
} from '../communities/entities/community-post-reaction.entity';
import { CommunityPostReply } from '../communities/entities/community-post-reply.entity';

/**
 * The interaction state one feed card needs to be actable instead of
 * read-only (SOC-04).
 *
 * `myReaction` is the viewer's OWN reaction key, or null. It is a key rather
 * than a boolean so the field can carry a richer palette later without a
 * contract change; today the feed only ever writes the reserved
 * `ReactionKey.Like`, which is exactly the counter
 * `POST /community-posts/:id/like` maintains. The four-key heart/celebrate/
 * support/fire palette stays on the community surface (`CommunityPostDTO`
 * excludes `like` from its summary for the same reason), so the two counters
 * never disagree about what they are counting.
 */
export interface FeedPostInteractions {
  reactionCount: number;
  replyCount: number;
  myReaction: string | null;
}

export const EMPTY_POST_INTERACTIONS: FeedPostInteractions = {
  reactionCount: 0,
  replyCount: 0,
  myReaction: null,
};

/** Raw shape of the grouped reaction read below (Postgres returns counts as
 *  strings over the wire, hence the `Number(...)` coercion at the call site). */
interface ReactionCountRow {
  post_id: string;
  total: string;
  mine: string;
}

interface ReplyCountRow {
  post_id: string;
  total: string;
}

/**
 * Batched reaction/reply state for a whole feed page.
 *
 * Two grouped queries for the entire page, never one per card: a 20-card page
 * costs exactly two round-trips, both served by
 * `IDX_community_post_reactions_post_id` and
 * `IDX_community_post_replies_feed_order`. The viewer's own reaction comes
 * back in the same pass as the totals via a `FILTER (WHERE user_id = …)`
 * aggregate, so knowing "did I react?" costs nothing extra.
 */
@Injectable()
export class FeedInteractionsService {
  constructor(
    @InjectRepository(CommunityPostReaction)
    private readonly reactions: Repository<CommunityPostReaction>,
    @InjectRepository(CommunityPostReply)
    private readonly replies: Repository<CommunityPostReply>,
  ) {}

  /**
   * Interaction state keyed by post id. Posts with no reactions and no
   * replies are simply absent from the map; callers fall back to
   * {@link EMPTY_POST_INTERACTIONS}.
   */
  async forPosts(
    postIds: string[],
    viewerId: string,
  ): Promise<Map<string, FeedPostInteractions>> {
    const byPostId = new Map<string, FeedPostInteractions>();
    if (!postIds.length) return byPostId;

    const [reactionRows, replyRows] = await Promise.all([
      this.reactions
        .createQueryBuilder('reaction')
        .select('reaction.post_id', 'post_id')
        .addSelect('COUNT(*)', 'total')
        .addSelect(
          'COUNT(*) FILTER (WHERE reaction.user_id = :viewerId)',
          'mine',
        )
        .where('reaction.post_id IN (:...postIds)', { postIds })
        .andWhere('reaction.key = :likeKey', { likeKey: ReactionKey.Like })
        .setParameter('viewerId', viewerId)
        .groupBy('reaction.post_id')
        .getRawMany<ReactionCountRow>(),
      this.replies
        .createQueryBuilder('reply')
        .select('reply.post_id', 'post_id')
        .addSelect('COUNT(*)', 'total')
        .where('reply.post_id IN (:...postIds)', { postIds })
        .andWhere('reply.deleted_at IS NULL')
        .groupBy('reply.post_id')
        .getRawMany<ReplyCountRow>(),
    ]);

    const ensure = (postId: string): FeedPostInteractions => {
      const existing = byPostId.get(postId);
      if (existing) return existing;
      const created: FeedPostInteractions = { ...EMPTY_POST_INTERACTIONS };
      byPostId.set(postId, created);
      return created;
    };

    for (const row of reactionRows) {
      const interactions = ensure(row.post_id);
      interactions.reactionCount = Number(row.total);
      interactions.myReaction =
        Number(row.mine) > 0 ? String(ReactionKey.Like) : null;
    }
    for (const row of replyRows) {
      ensure(row.post_id).replyCount = Number(row.total);
    }

    return byPostId;
  }
}
