import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { Profile } from '../users/entities/profile.entity';
import {
  CommunityBanDTO,
  CommunityBanListDTO,
  toCommunityBanDTO,
} from './community-bans-response';
import { CommunityGovernanceLogService } from './community-governance-log.service';
import { resolveStaffCommunity } from './community-staff-access';
import { CommunityBan } from './entities/community-ban.entity';
import { GovernanceLogAction } from './entities/community-governance-log.entity';
import { CommunityMember } from './entities/community-member.entity';
import { Community } from './entities/community.entity';

/**
 * Backs the READ and LIFT side of `community_bans`
 * (`GET /communities/:slug/bans`, `DELETE /communities/:slug/bans/:memberSlug`).
 *
 * The write side, inserting the ban row when a moderator removes someone,
 * belongs to the moderation path in `CommunitiesService` and is deliberately
 * not duplicated here. What was missing is everything after that insert: a ban
 * that no one can list is a ban no one can review, and a ban that cannot be
 * lifted turns every moderation call into a permanent one. Moderators need to
 * be able to change their minds.
 *
 * Standalone service + controller, the convention this module already follows
 * (`CommunityPulseService`, `CommunityInsightsService`). Owner, co-owner and
 * moderator on both routes.
 */
@Injectable()
export class CommunityBansService {
  private readonly logger = new Logger(CommunityBansService.name);

  constructor(
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly members: Repository<CommunityMember>,
    @InjectRepository(CommunityBan)
    private readonly bans: Repository<CommunityBan>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly governanceLog: CommunityGovernanceLogService,
  ) {}

  /**
   * Everyone currently barred from this community, newest ban first, for its
   * owner, co-owners and moderators.
   *
   * Both member and moderator profiles resolve through one batched
   * `MemberLookup.byUserIds` call rather than a query per row.
   */
  async listBySlug(slug: string, userId: string): Promise<CommunityBanListDTO> {
    const { community } = await resolveStaffCommunity(
      this.communities,
      this.members,
      slug,
      userId,
    );

    const rows = await this.bans.find({
      where: { communityId: community.id },
      order: { createdAt: 'DESC' },
    });
    if (!rows.length) return { bans: [], total: 0 };

    const referencedUserIds = [
      ...new Set(
        rows
          .flatMap((row) => [row.userId, row.bannedByUserId])
          .filter((id): id is string => id !== null),
      ),
    ];
    const refByUserId: Map<string, MemberRef> = await new MemberLookup(
      this.profiles,
    ).byUserIds(referencedUserIds);

    const bans: CommunityBanDTO[] = rows.map((row) =>
      toCommunityBanDTO(
        row,
        refByUserId.get(row.userId) ?? null,
        row.bannedByUserId
          ? (refByUserId.get(row.bannedByUserId) ?? null)
          : null,
      ),
    );
    return { bans, total: bans.length };
  }

  /**
   * Lift one ban (owner, co-owner or moderator). The row is deleted, which is
   * what every join path already reads as "not barred" (`community_bans` is
   * checked by existence, so a lifted ban leaves nothing to interpret).
   *
   * Lifting a ban does NOT put the member back on the roster. It reopens the
   * door; walking through it is still their decision, through the community's
   * ordinary join path and whatever review that path carries. This is the same
   * no-consent-less-roster-adds rule the invite path follows.
   */
  async liftBan(
    slug: string,
    actorUserId: string,
    memberSlug: string,
  ): Promise<{ ok: true }> {
    const { community } = await resolveStaffCommunity(
      this.communities,
      this.members,
      slug,
      actorUserId,
    );

    // Resolved straight off `profiles`, not through `MemberLookup`, which
    // restricts to ACTIVE users: a banned member may well be suspended, and a
    // moderator must still be able to lift the community-level ban on them.
    const profile = await this.profiles.findOne({
      where: { slug: memberSlug },
      select: { userId: true },
    });
    const ban = profile
      ? await this.bans.findOne({
          where: { communityId: community.id, userId: profile.userId },
        })
      : null;
    if (!ban) {
      throw new NotFoundException('No ban found for that member');
    }

    await this.bans.delete({ id: ban.id });
    await this.logBanLifted(community.id, actorUserId, ban);
    return { ok: true };
  }

  /**
   * Audit entry for a lift that has already committed. Own try/catch, the
   * contract `CommunityOwnerOrphanService` and `CommunityAutoFreezeService`
   * both follow: the ban is already gone, and a failed log write must not be
   * reported to the moderator as a failed lift.
   */
  private async logBanLifted(
    communityId: string,
    actorUserId: string,
    ban: CommunityBan,
  ): Promise<void> {
    try {
      await this.governanceLog.log({
        communityId,
        actorUserId,
        action: GovernanceLogAction.BanLifted,
        targetUserId: ban.userId,
        metadata: {
          bannedAt: ban.createdAt.toISOString(),
          bannedByUserId: ban.bannedByUserId,
          banReason: ban.reason,
        },
      });
    } catch (error) {
      this.logger.warn(
        `Ban on user ${ban.userId} in community ${communityId} was lifted, but the governance log entry could not be written: ${String(error)}.`,
      );
    }
  }
}
