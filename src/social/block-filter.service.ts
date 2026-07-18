import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';
import { Block } from './entities/block.entity';
import { Mute } from './entities/mute.entity';

/**
 * Cross-cutting block/mute enforcement (spec §2). Exported from
 * `SocialModule` for other domains (messaging, connections, profiles/members
 * directory, feed) to wire in — see the module report for the exact import
 * path. Enforcement here is server-authoritative; callers must not rely on
 * the frontend to have already filtered anything.
 */
@Injectable()
export class BlockFilterService {
  constructor(
    @InjectRepository(Block) private readonly blocks: Repository<Block>,
    @InjectRepository(Mute) private readonly mutes: Repository<Mute>,
  ) {}

  /**
   * Hard severance, direction-agnostic: `true` if either `aUserId` blocked
   * `bUserId` or `bUserId` blocked `aUserId`. Use this to gate messaging,
   * connection requests, and any other mutual interaction — a block from
   * either side should sever it.
   */
  async isBlockedEitherWay(aUserId: string, bUserId: string): Promise<boolean> {
    if (aUserId === bUserId) return false;
    return this.blocks.exist({
      where: [
        { blockerId: aUserId, blockedId: bUserId },
        { blockerId: bUserId, blockedId: aUserId },
      ],
    });
  }

  /**
   * One-way, soft silence: `true` when `actorId` has muted `targetId` — i.e.
   * `targetId` should be suppressed (hidden from feeds/lists, notifications
   * skipped) from `actorId`'s point of view. Unlike `isBlockedEitherWay`,
   * this is directional and never implies the reverse.
   */
  async isMutedBy(actorId: string, targetId: string): Promise<boolean> {
    if (actorId === targetId) return false;
    return this.mutes.exist({
      where: { muterId: actorId, mutedId: targetId },
    });
  }

  /**
   * Appends a `NOT EXISTS` predicate to `qb` that drops rows whose member
   * column is blocked either way relative to `actorId`. `memberIdColumn`
   * is spliced verbatim into raw SQL, so pass an actual, already-quoted
   * `"alias"."snake_case_column"` reference matching `qb`'s alias and the
   * DB's `SnakeNamingStrategy` column name (e.g. `'"cp"."author_id"'`), not
   * a TypeORM camelCase property path. Call once per query builder — the
   * bound parameter name (`blockFilterActorId`) is fixed.
   */
  excludeBlocked<E extends ObjectLiteral>(
    qb: SelectQueryBuilder<E>,
    actorId: string,
    memberIdColumn: string,
  ): SelectQueryBuilder<E> {
    return qb.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM "blocks" "__block_filter"
        WHERE ("__block_filter"."blocker_id" = :blockFilterActorId AND "__block_filter"."blocked_id" = ${memberIdColumn})
           OR ("__block_filter"."blocked_id" = :blockFilterActorId AND "__block_filter"."blocker_id" = ${memberIdColumn})
      )`,
      { blockFilterActorId: actorId },
    );
  }

  /**
   * Directional sibling of `excludeBlocked`: appends a `NOT EXISTS` predicate
   * dropping rows whose member column `actorId` has muted. Same raw-SQL
   * splicing contract as `excludeBlocked` — pass an already-quoted
   * `"alias"."snake_case_column"`. Binds its own parameter name
   * (`muteFilterActorId`), so a single query builder can safely carry both
   * this and `excludeBlocked`; like that method, call it at most once per
   * query builder.
   *
   * Content lists generally want BOTH (a block hides bidirectionally, a mute
   * one-directionally) — see `excludeHidden`, which applies the pair.
   */
  excludeMuted<E extends ObjectLiteral>(
    qb: SelectQueryBuilder<E>,
    actorId: string,
    memberIdColumn: string,
  ): SelectQueryBuilder<E> {
    return qb.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM "mutes" "__mute_filter"
        WHERE "__mute_filter"."muter_id" = :muteFilterActorId
          AND "__mute_filter"."muted_id" = ${memberIdColumn}
      )`,
      { muteFilterActorId: actorId },
    );
  }

  /**
   * The composition every *content list* should use: hide authors blocked in
   * either direction (hard severance) and authors `actorId` has muted (soft,
   * one-way silence — `isMutedBy`'s docstring: a muted author's content is
   * "hidden from feeds/lists"). This is the in-query equivalent of
   * `FeedService.dropBlocked`, and is preferred over it: filtering inside the
   * query lets `LIMIT` count only visible rows, so a page of 20 comes back
   * with 20 items instead of being silently short (the known flaw of
   * post-query filtering).
   */
  excludeHidden<E extends ObjectLiteral>(
    qb: SelectQueryBuilder<E>,
    actorId: string,
    memberIdColumn: string,
  ): SelectQueryBuilder<E> {
    this.excludeBlocked(qb, actorId, memberIdColumn);
    return this.excludeMuted(qb, actorId, memberIdColumn);
  }

  /**
   * Batched set lookup for collections that are **not** paginated in SQL —
   * nested replies, attendee lists — where the in-query `excludeHidden`
   * predicate has nowhere to attach and post-query filtering carries no
   * short-page penalty (there is no `LIMIT` to under-fill).
   *
   * Two queries total regardless of `candidateIds` length, unlike
   * `FeedService.dropBlocked`'s per-author `exist()` calls. `actorId` is never
   * reported as hidden from itself.
   */
  async blockedUserIds(
    actorId: string,
    candidateIds: string[],
  ): Promise<Set<string>> {
    const ids = [...new Set(candidateIds)].filter((id) => id !== actorId);
    if (!ids.length) return new Set();
    const rows = await this.blocks.find({
      where: [
        { blockerId: actorId, blockedId: In(ids) },
        { blockedId: actorId, blockerId: In(ids) },
      ],
      select: { blockerId: true, blockedId: true },
    });
    return new Set(
      rows.map((r) => (r.blockerId === actorId ? r.blockedId : r.blockerId)),
    );
  }

  /** One-way companion to `blockedUserIds`: the subset `actorId` has muted. */
  async mutedUserIds(
    actorId: string,
    candidateIds: string[],
  ): Promise<Set<string>> {
    const ids = [...new Set(candidateIds)].filter((id) => id !== actorId);
    if (!ids.length) return new Set();
    const rows = await this.mutes.find({
      where: { muterId: actorId, mutedId: In(ids) },
      select: { mutedId: true },
    });
    return new Set(rows.map((r) => r.mutedId));
  }

  /** Union of `blockedUserIds` and `mutedUserIds` — the post-query analogue
   *  of `excludeHidden`, for non-paginated collections. */
  async hiddenUserIds(
    actorId: string,
    candidateIds: string[],
  ): Promise<Set<string>> {
    const [blocked, muted] = await Promise.all([
      this.blockedUserIds(actorId, candidateIds),
      this.mutedUserIds(actorId, candidateIds),
    ]);
    for (const id of muted) blocked.add(id);
    return blocked;
  }
}
