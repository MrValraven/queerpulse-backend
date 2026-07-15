import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';
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
}
