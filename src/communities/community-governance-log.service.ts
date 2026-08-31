import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, SelectQueryBuilder } from 'typeorm';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import { Profile } from '../users/entities/profile.entity';
import {
  CommunityGovernanceLog,
  GovernanceLogAction,
} from './entities/community-governance-log.entity';

/**
 * The `mod_audit_logs.action` strings a community ban writes (TS-10).
 *
 * A community ban used to write nothing into `mod_audit_logs` at all, which is
 * why it was unappealable: `POST /appeals` resolves the thing being appealed
 * out of that table, so an act that leaves no row there cannot be argued with.
 * These two rows are what make a community ban reachable by the appeal path.
 *
 * Both are report-less (`reportId: null`) and member-directed
 * (`targetUserId` + `targetName`), the same shape
 * `AdminMemberModerationService.citeMember` and
 * `AdminMembersService.updateRole` already write.
 */
export const COMMUNITY_BAN_AUDIT_ACTION = 'community_ban_applied';
export const COMMUNITY_BAN_LIFTED_AUDIT_ACTION = 'community_ban_lifted';

/**
 * The `mod_audit_logs.action` string a removal that LETS THE MEMBER COME BACK
 * writes (PRD-28).
 *
 * The bar had this row and the plain removal did not, so a removal wrote only
 * `community_governance_log` and the appeal machinery, which reads
 * `mod_audit_logs`, could not see it. The member can rejoin, so what was lost
 * is the record of a moderator's decision about them and with it any way to
 * contest it.
 *
 * A DISTINCT ACTION RATHER THAN `COMMUNITY_BAN_AUDIT_ACTION` WITH A FLAG: the
 * appeals queue labels and reasons about a row by its action alone
 * (`OUTCOME_LABEL` in `moderation-response.ts`,
 * `ModerationService.revertOriginalAction`), so a removal filed under the ban's
 * action would be read, labelled and possibly reversed as a bar. The same
 * distinction `GovernanceLogAction.MemberRemoved` vs `MemberBanned` already
 * draws on the community's own log.
 *
 * Written by `CommunitiesService.removeMember` for a STAFF removal only. A
 * self-leave writes nothing here: leaving is not a moderation act and there is
 * nothing to appeal.
 */
export const COMMUNITY_REMOVAL_AUDIT_ACTION = 'community_member_removed';

/** One `mod_audit_logs` row for a community-level sanction. */
export interface CommunityModAuditInput {
  actorUserId: string;
  action: string;
  targetUserId: string;
  reasonCode?: string | null;
  note?: string | null;
  /** e.g. `"7d"`, matching the `duration` a platform restrict/suspend writes. */
  duration?: string | null;
}

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
  private readonly logger = new Logger(CommunityGovernanceLogService.name);

  constructor(
    @InjectRepository(CommunityGovernanceLog)
    private readonly governanceLogs: Repository<CommunityGovernanceLog>,
    // `mod_audit_logs` and `profiles` are reached through the shared
    // `DataSource` rather than an injected repository, so this service needs no
    // new `TypeOrmModule.forFeature` entry and `CommunitiesModule` needs no
    // import of `ModerationModule`. Same reasoning `ReportSubjectResolverService`
    // records for its own cross-module reads: the module graph stays as it is.
    private readonly dataSource: DataSource,
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
   * Mirror a community-level sanction into `mod_audit_logs`, the table
   * `POST /appeals` resolves an appeal's target from.
   *
   * This is what makes a community ban appealable (TS-10). The community's own
   * `community_governance_log` answers "what did this room's staff do"; it is
   * not reachable by the appeal path, and duplicating the record into the
   * platform audit table is the smallest change that gives a barred member
   * somewhere to argue.
   *
   * `targetName` is a write-time snapshot of the member's display name, so the
   * row still says who it is about after their account is erased (the FK is
   * `ON DELETE SET NULL`) or after they change their name. Written directly
   * rather than through `ModAuditService.writeAuditLog`, which carries no
   * target-member parameter, exactly as
   * `AdminMemberModerationService.citeMember` already does and documents.
   *
   * Best effort with its own try/catch, the contract every logging helper in
   * this module follows: the sanction has already committed, and a failed
   * audit write must never be reported to the moderator as a failed ban.
   */
  async logModerationAudit(input: CommunityModAuditInput): Promise<void> {
    try {
      const profiles = this.dataSource.getRepository(Profile);
      const auditLogs = this.dataSource.getRepository(ModAuditLog);
      const profile = await profiles.findOne({
        where: { userId: input.targetUserId },
        select: { firstName: true, lastName: true },
      });
      const targetName = profile
        ? `${profile.firstName} ${profile.lastName}`.trim() || null
        : null;

      await auditLogs.save(
        auditLogs.create({
          reportId: null,
          actorId: input.actorUserId,
          action: input.action,
          targetUserId: input.targetUserId,
          targetName,
          reasonCode: input.reasonCode ?? null,
          note: input.note ?? null,
          duration: input.duration ?? null,
        }),
      );
    } catch (error) {
      this.logger.warn(
        `Community sanction "${input.action}" against user ${input.targetUserId} committed, but the mod_audit_logs mirror could not be written: ${String(error)}.`,
      );
    }
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
