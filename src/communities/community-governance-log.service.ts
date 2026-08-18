import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
 * committed. Wiring the `CommunitiesService` call sites is a follow-up task;
 * this service only needs to exist and work.
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
}
