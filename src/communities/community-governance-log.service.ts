import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import {
  CommunityGovernanceLog,
  GovernanceLogAction,
} from './entities/community-governance-log.entity';

export interface LogGovernanceActionInput {
  communityId: string;
  // `null` for system-driven actions (e.g. an auto-freeze, or the automatic
  // owner→mod promotion on owner account erasure) with no human actor.
  actorUserId: string | null;
  action: GovernanceLogAction;
  targetUserId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * The single write path into `community_governance_log`
 * (`src/communities/entities/community-governance-log.entity.ts`). Nothing
 * else should `INSERT` into that table directly — every governance action
 * against a community's roster/lifecycle goes through `log()` so the audit
 * trail has one consistent shape.
 *
 * Intentionally does not itself decide WHEN to log — `CommunitiesService`
 * (manual role changes, removals, ownership transfers, archive/freeze/
 * unfreeze) and `CommunityOwnerOrphanService` (automatic owner→mod
 * promotion on owner erasure) call this after their own action has already
 * committed.
 *
 * `entriesForCommunity()` is the matching read path — the table was
 * write-only until BE-COM-15, so "who removed me?"/"who unfroze this?" could
 * not be answered from the product at all. It returns a query builder rather
 * than rows so the caller owns pagination (`paginate()`) and the
 * actor/target name resolution, which needs a `profiles` repository this
 * service deliberately does not carry.
 */
@Injectable()
export class CommunityGovernanceLogService {
  constructor(
    @InjectRepository(CommunityGovernanceLog)
    private readonly governanceLogs: Repository<CommunityGovernanceLog>,
  ) {}

  async log(input: LogGovernanceActionInput): Promise<void> {
    // `.save(this.governanceLogs.create(...))`, not `.insert(...)`: `insert`'s
    // `QueryDeepPartialEntity` mapped type rejects a plain `Record<string,
    // unknown>` for lacking an index signature it can recurse into (same
    // class of issue noted on `Report.evidence`) — `create`+`save` takes the
    // concrete entity shape instead and has no such trouble.
    await this.governanceLogs.save(
      this.governanceLogs.create({
        communityId: input.communityId,
        actorUserId: input.actorUserId,
        action: input.action,
        targetUserId: input.targetUserId ?? null,
        metadata: input.metadata ?? null,
      }),
    );
  }

  /**
   * Newest-first governance entries for one community, as an unexecuted query
   * builder so the caller can page it with `paginate()`.
   *
   * Ordered by `created_at DESC, id DESC`: `created_at` alone is not unique
   * (two entries written inside one transaction share a timestamp to the
   * microsecond), and an offset page over a non-deterministic order can
   * repeat or skip a row at the page boundary. Served by
   * `IDX_community_governance_log_community_id_created_at`
   * (`1793620000000-AddCommunityGovernanceLogCommunityCreatedAtIndex`).
   */
  entriesForCommunity(
    communityId: string,
  ): SelectQueryBuilder<CommunityGovernanceLog> {
    return this.governanceLogs
      .createQueryBuilder('entry')
      .where('entry.community_id = :communityId', { communityId })
      .orderBy('entry.created_at', 'DESC')
      .addOrderBy('entry.id', 'DESC');
  }
}
