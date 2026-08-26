import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Community } from '../communities/entities/community.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import {
  FeedSourceKind,
  FeedSourceMute,
} from './entities/feed-source-mute.entity';
import { FeedMutedSourceResponse } from './feed-mute-response';

/**
 * The source ids one viewer has muted, split by kind so `fetchCandidates`
 * can apply each to the columns that actually carry it. Empty arrays mean
 * "nothing muted" and every caller must skip the predicate entirely rather
 * than emitting an `IN ()`, which is invalid SQL.
 */
export interface MutedFeedSources {
  communityIds: string[];
  forumThreadIds: string[];
}

export const NO_MUTED_SOURCES: MutedFeedSources = {
  communityIds: [],
  forumThreadIds: [],
};

/**
 * "Show me less of this" (SOC-18), as a member's own per-source feed
 * preference.
 *
 * Muting here NEVER changes membership. This service touches
 * `feed_source_mutes` and nothing else: no roster row is written, no
 * notification preference is changed, and the muted community is never told.
 * A member who wants a quieter home screen should not have to leave the room
 * to get one.
 *
 * Every mute is reversible and findable: `list` resolves each row back to the
 * community or thread it names so the frontend can render a managed list, and
 * `unmute` removes it. A row whose subject no longer exists is dropped from
 * `list` rather than shown as a dead entry, and stays harmlessly in the table
 * (there is no FK on `source_id` — see the entity).
 */
@Injectable()
export class FeedMuteService {
  constructor(
    @InjectRepository(FeedSourceMute)
    private readonly mutes: Repository<FeedSourceMute>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(ForumThread)
    private readonly forumThreads: Repository<ForumThread>,
  ) {}

  /**
   * Every source this viewer has muted, grouped by kind. Called once per feed
   * page (see `FeedService.getFeed`), so it is one small indexed read on
   * `IDX_feed_source_mutes_user_id` rather than a per-candidate lookup.
   */
  async mutedSources(viewerId: string): Promise<MutedFeedSources> {
    const rows = await this.mutes.find({ where: { userId: viewerId } });
    const communityIds: string[] = [];
    const forumThreadIds: string[] = [];
    for (const row of rows) {
      if (row.sourceKind === FeedSourceKind.Community) {
        communityIds.push(row.sourceId);
      } else {
        forumThreadIds.push(row.sourceId);
      }
    }
    return { communityIds, forumThreadIds };
  }

  /**
   * `POST /feed/mutes` — idempotent. A second tap on "show less of this"
   * re-affirms the existing row through `ON CONFLICT DO NOTHING` rather than
   * raising 23505 on `UQ_feed_source_mutes`.
   *
   * The subject is checked to exist first, so a typo'd or forged id becomes a
   * 404 instead of a permanent orphan row the member can never see in their
   * managed list to remove.
   */
  async mute(
    viewerId: string,
    sourceKind: FeedSourceKind,
    sourceId: string,
  ): Promise<{ muted: true }> {
    await this.assertSourceExists(sourceKind, sourceId);
    await this.mutes
      .createQueryBuilder()
      .insert()
      .into(FeedSourceMute)
      .values({ userId: viewerId, sourceKind, sourceId })
      .orIgnore()
      .execute();
    return { muted: true };
  }

  /**
   * `DELETE /feed/mutes/:sourceKind/:sourceId` — also idempotent: unmuting
   * something that was never muted is a no-op, not a 404. The member's intent
   * ("I want to see this again") is already satisfied.
   */
  async unmute(
    viewerId: string,
    sourceKind: FeedSourceKind,
    sourceId: string,
  ): Promise<{ muted: false }> {
    await this.mutes.delete({ userId: viewerId, sourceKind, sourceId });
    return { muted: false };
  }

  /**
   * `GET /feed/mutes` — the managed list, newest mute first. Names are
   * resolved in two batched `IN` queries (one per kind), never one per row.
   */
  async list(viewerId: string): Promise<FeedMutedSourceResponse[]> {
    const rows = await this.mutes.find({
      where: { userId: viewerId },
      order: { createdAt: 'DESC' },
    });
    if (!rows.length) return [];

    const communityIds = rows
      .filter((row) => row.sourceKind === FeedSourceKind.Community)
      .map((row) => row.sourceId);
    const forumThreadIds = rows
      .filter((row) => row.sourceKind === FeedSourceKind.ForumThread)
      .map((row) => row.sourceId);

    const [communityRows, threadRows] = await Promise.all([
      communityIds.length
        ? this.communities.find({ where: { id: In(communityIds) } })
        : Promise.resolve([]),
      forumThreadIds.length
        ? this.forumThreads.find({ where: { id: In(forumThreadIds) } })
        : Promise.resolve([]),
    ]);
    const communityById = new Map(
      communityRows.map((community) => [community.id, community]),
    );
    const threadById = new Map(threadRows.map((thread) => [thread.id, thread]));

    const resolved: FeedMutedSourceResponse[] = [];
    for (const row of rows) {
      if (row.sourceKind === FeedSourceKind.Community) {
        const community = communityById.get(row.sourceId);
        if (!community) continue;
        resolved.push({
          sourceKind: FeedSourceKind.Community,
          sourceId: row.sourceId,
          name: community.name,
          link: `/community/${community.slug}`,
          mutedAt: row.createdAt.toISOString(),
        });
        continue;
      }
      const thread = threadById.get(row.sourceId);
      if (!thread) continue;
      resolved.push({
        sourceKind: FeedSourceKind.ForumThread,
        sourceId: row.sourceId,
        name: thread.title,
        link: `/thread/${thread.slug}`,
        mutedAt: row.createdAt.toISOString(),
      });
    }
    return resolved;
  }

  private async assertSourceExists(
    sourceKind: FeedSourceKind,
    sourceId: string,
  ): Promise<void> {
    const exists =
      sourceKind === FeedSourceKind.Community
        ? await this.communities.exist({ where: { id: sourceId } })
        : await this.forumThreads.exist({ where: { id: sourceId } });
    if (!exists) {
      throw new NotFoundException('That source does not exist.');
    }
  }
}
