import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { Paginated, normalizePage, paginate } from '../common/pagination';
import { Profile } from '../users/entities/profile.entity';
import {
  CommunityGovernanceLogEntryDTO,
  toCommunityGovernanceLogEntry,
} from './community-governance-history-response';
import { CommunityGovernanceLogService } from './community-governance-log.service';
import { resolveStaffCommunity } from './community-staff-access';
import { ListCommunityGovernanceLogQuery } from './dto/list-community-governance-log.query';
import { CommunityMember } from './entities/community-member.entity';
import { Community } from './entities/community.entity';

/**
 * Backs `GET /communities/:slug/governance-log`, the community-facing read of
 * `community_governance_log`.
 *
 * The table had exactly one reader, `GET /admin/communities/:slug/governance-log`,
 * gated to platform admins. So a community's own owner could not see the audit
 * trail of their own community: when two moderators disagreed about who removed
 * whom, the answer sat in the database and only platform staff could reach it.
 * This is the same trail, read by the people it is about.
 *
 * Named "history" rather than "log" purely to avoid colliding with
 * `CommunityGovernanceLogService`, which owns the WRITE path and the shared
 * `entriesForCommunity()` query builder in this same folder. That builder is
 * reused here rather than re-querying the table, so both readers share one
 * ordering (`created_at DESC, id DESC`) and one index
 * (`IDX_community_governance_log_community_id_created_at`).
 *
 * Standalone service + controller, the convention this module follows for
 * `CommunityPulseService`, `CommunityInsightsService` and `CommunityBansService`:
 * a new read endpoint never lands as a method on `CommunitiesController`.
 */
@Injectable()
export class CommunityGovernanceHistoryService {
  constructor(
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly members: Repository<CommunityMember>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly governanceLog: CommunityGovernanceLogService,
  ) {}

  /**
   * One page of this community's governance trail, newest first, for its
   * owner, co-owners and moderators.
   *
   * Authorization is `resolveStaffCommunity` verbatim (404 for an unknown or
   * archived slug, 403 for anyone else including a plain member), which is the
   * same owner/co-owner/mod tier every other staff route in this module uses.
   * It is not reimplemented here: one definition of "this community's staff"
   * is the point of that file.
   *
   * Actor and target names resolve through ONE batched
   * `MemberLookup.byUserIds` call per page, covering every entry at once. A
   * per-row lookup would cost forty queries on a page of twenty entries with
   * two people each.
   *
   * `paginate()` pages with `.skip()/.take()`, which is safe here because
   * `entriesForCommunity()` builds a join-free query. The
   * "column distinctAlias.X does not exist" failure only bites when a join is
   * present and the ORDER BY names a joined alias.
   */
  async listBySlug(
    slug: string,
    userId: string,
    query: ListCommunityGovernanceLogQuery,
  ): Promise<Paginated<CommunityGovernanceLogEntryDTO>> {
    const { community } = await resolveStaffCommunity(
      this.communities,
      this.members,
      slug,
      userId,
    );

    const queryBuilder = this.governanceLog.entriesForCommunity(community.id);
    if (query.action) {
      queryBuilder.andWhere('entry.action = :action', { action: query.action });
    }

    return paginate(queryBuilder, normalizePage(query.page), async (rows) => {
      const referencedUserIds = [
        ...new Set(
          rows
            .flatMap((row) => [row.actorUserId, row.targetUserId])
            .filter((id): id is string => id !== null),
        ),
      ];
      const refByUserId: Map<string, MemberRef> = await new MemberLookup(
        this.profiles,
      ).byUserIds(referencedUserIds);

      return rows.map((row) => toCommunityGovernanceLogEntry(row, refByUserId));
    });
  }
}
