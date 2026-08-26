import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import {
  banExpiryFromDays,
  CommunityBanDTO,
  CommunityBanListDTO,
  CommunityRuleOptionDTO,
  resolveRuleSnapshot,
  toCommunityBanDTO,
} from './community-bans-response';
import {
  COMMUNITY_BAN_AUDIT_ACTION,
  COMMUNITY_BAN_LIFTED_AUDIT_ACTION,
  CommunityGovernanceLogService,
} from './community-governance-log.service';
import { resolveStaffCommunity } from './community-staff-access';
import { UpdateCommunityBanDto } from './dto/update-community-ban.dto';
import { CommunityBan } from './entities/community-ban.entity';
import { GovernanceLogAction } from './entities/community-governance-log.entity';
import { CommunityMember } from './entities/community-member.entity';
import { Community } from './entities/community.entity';

/**
 * Backs the READ, EDIT and LIFT side of `community_bans`
 * (`GET /communities/:slug/bans`,
 * `PATCH /communities/:slug/bans/:memberSlug`,
 * `DELETE /communities/:slug/bans/:memberSlug`).
 *
 * The write side, inserting the ban row when a moderator removes someone,
 * belongs to the moderation path in `CommunitiesService` and is deliberately
 * not duplicated here. What was missing is everything after that insert: a ban
 * that no one can list is a ban no one can review, and a ban that cannot be
 * lifted turns every moderation call into a permanent one. Moderators need to
 * be able to change their minds.
 *
 * `updateBan` is the second half of that (TS-10): a ban already in place can be
 * given an end date, shortened, extended, re-explained, or pointed at the house
 * rule it rests on, without being lifted and reapplied. Every ban written
 * before timed bans existed is permanent, and this is the route that turns one
 * of them into something a member can serve out.
 *
 * Standalone service + controller, the convention this module already follows
 * (`CommunityPulseService`, `CommunityInsightsService`). Owner, co-owner and
 * moderator on all three routes.
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
    // The barred member is told when their ban changes shape. A ban used to
    // reach them as nothing at all, which is what made "contact its
    // moderators" the only thing the product could say to them.
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Everyone currently barred from this community, newest ban first, for its
   * owner, co-owners and moderators.
   *
   * Expired bans are still listed, flagged `isExpired`. They no longer bar
   * anyone (every join path filters on the clock), and hiding them would erase
   * the record of a sanction that was served, which is precisely what a
   * reviewable ladder needs to keep.
   *
   * The community's current rules ride along so the panel can render a
   * citation picker without a second request. Staff-only route, and a
   * community's rules are already visible to its members.
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

    const rules: CommunityRuleOptionDTO[] = (community.rules ?? [])
      .map((text, index) => ({ index, text: text.trim() }))
      .filter((rule) => rule.text.length > 0);

    const rows = await this.bans.find({
      where: { communityId: community.id },
      order: { createdAt: 'DESC' },
    });
    if (!rows.length) {
      return {
        bans: [],
        total: 0,
        rules,
        rulesVersion: community.rulesVersion,
      };
    }

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

    const now = new Date();
    const bans: CommunityBanDTO[] = rows.map((row) =>
      toCommunityBanDTO(
        row,
        refByUserId.get(row.userId) ?? null,
        row.bannedByUserId
          ? (refByUserId.get(row.bannedByUserId) ?? null)
          : null,
        community.rulesVersion,
        now,
      ),
    );
    return {
      bans,
      total: bans.length,
      rules,
      rulesVersion: community.rulesVersion,
    };
  }

  /**
   * Revise a ban already in place (owner, co-owner or moderator): give it an
   * end date, make it permanent again, rewrite the reason, cite a house rule,
   * or drop a citation made in error.
   *
   * The two pairs are mutually exclusive on purpose. `banDays` with
   * `makePermanent`, or `ruleIndex` with `clearRule`, is a request that
   * contradicts itself, and quietly resolving one of those is how a moderator
   * ends up having done something to a member's standing that they never
   * intended.
   *
   * Everything that changes is recorded in the community's governance log, in
   * `mod_audit_logs` (so the revised ban stays appealable), and told to the
   * member. A sanction whose terms move without the person serving it being
   * told is the unexplained enforcement the notification pipeline exists to
   * prevent.
   */
  async updateBan(
    slug: string,
    actorUserId: string,
    memberSlug: string,
    dto: UpdateCommunityBanDto,
  ): Promise<CommunityBanDTO> {
    if (dto.banDays !== undefined && dto.makePermanent) {
      throw new BadRequestException(
        'An end date and `makePermanent` contradict each other. Send one.',
      );
    }
    if (dto.ruleIndex !== undefined && dto.clearRule) {
      throw new BadRequestException(
        'A rule to cite and `clearRule` contradict each other. Send one.',
      );
    }

    const { community } = await resolveStaffCommunity(
      this.communities,
      this.members,
      slug,
      actorUserId,
    );
    const ban = await this.findBanOr404(community.id, memberSlug);

    const patch: Partial<CommunityBan> = {};

    if (dto.banDays !== undefined) {
      patch.expiresAt = banExpiryFromDays(dto.banDays);
    } else if (dto.makePermanent) {
      patch.expiresAt = null;
    }

    if (dto.reason !== undefined) {
      patch.reason = dto.reason.trim() || null;
    }

    if (dto.ruleIndex !== undefined) {
      const snapshot = resolveRuleSnapshot(
        community.rules,
        community.rulesVersion,
        dto.ruleIndex,
      );
      if (!snapshot) {
        throw new BadRequestException(
          "That rule is outside this community's current rules",
        );
      }
      patch.ruleIndex = snapshot.ruleIndex;
      patch.ruleVersion = snapshot.ruleVersion;
      patch.ruleText = snapshot.ruleText;
    } else if (dto.clearRule) {
      patch.ruleIndex = null;
      patch.ruleVersion = null;
      patch.ruleText = null;
    }

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('Nothing to change');
    }

    await this.bans.update({ id: ban.id }, patch);
    const updated: CommunityBan = { ...ban, ...patch };

    await this.logBanUpdated(community.id, actorUserId, ban, updated);
    await this.notifyBanUpdated(community, updated);

    const memberRef = await new MemberLookup(this.profiles).byUserIds([
      updated.userId,
    ]);
    return toCommunityBanDTO(
      updated,
      memberRef.get(updated.userId) ?? null,
      null,
      community.rulesVersion,
    );
  }

  /**
   * Lift one ban (owner, co-owner or moderator). The row is deleted, which
   * every join path reads as "not barred".
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

    const ban = await this.findBanOr404(community.id, memberSlug);

    await this.bans.delete({ id: ban.id });
    await this.logBanLifted(community.id, actorUserId, ban);
    return { ok: true };
  }

  /**
   * The ban on `memberSlug` in this community, or a 404.
   *
   * Resolved straight off `profiles`, not through `MemberLookup`, which
   * restricts to ACTIVE users: a banned member may well be suspended, and a
   * moderator must still be able to act on the community-level ban on them.
   */
  private async findBanOr404(
    communityId: string,
    memberSlug: string,
  ): Promise<CommunityBan> {
    const profile = await this.profiles.findOne({
      where: { slug: memberSlug },
      select: { userId: true },
    });
    const ban = profile
      ? await this.bans.findOne({
          where: { communityId, userId: profile.userId },
        })
      : null;
    if (!ban) {
      throw new NotFoundException('No ban found for that member');
    }
    return ban;
  }

  /**
   * Audit entries for a lift that has already committed: the community's own
   * governance log, plus the `mod_audit_logs` mirror that keeps the decision
   * inside the appeal path's reach.
   *
   * Own try/catch, the contract `CommunityOwnerOrphanService` and
   * `CommunityAutoFreezeService` both follow: the ban is already gone, and a
   * failed log write must not be reported to the moderator as a failed lift.
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
          banExpiresAt: ban.expiresAt?.toISOString() ?? null,
          ...(ban.ruleText !== null
            ? {
                ruleIndex: ban.ruleIndex,
                ruleVersion: ban.ruleVersion,
                ruleText: ban.ruleText,
              }
            : {}),
        },
      });
    } catch (error) {
      this.logger.warn(
        `Ban on user ${ban.userId} in community ${communityId} was lifted, but the governance log entry could not be written: ${String(error)}.`,
      );
    }
    await this.governanceLog.logModerationAudit({
      actorUserId,
      action: COMMUNITY_BAN_LIFTED_AUDIT_ACTION,
      targetUserId: ban.userId,
      note: ban.reason,
    });
  }

  /** The same pair of audit entries for a revision. */
  private async logBanUpdated(
    communityId: string,
    actorUserId: string,
    before: CommunityBan,
    after: CommunityBan,
  ): Promise<void> {
    try {
      await this.governanceLog.log({
        communityId,
        actorUserId,
        action: GovernanceLogAction.MemberBanned,
        targetUserId: after.userId,
        metadata: {
          revised: true,
          fromExpiresAt: before.expiresAt?.toISOString() ?? null,
          toExpiresAt: after.expiresAt?.toISOString() ?? null,
          reason: after.reason,
          ruleIndex: after.ruleIndex,
          ruleVersion: after.ruleVersion,
          ruleText: after.ruleText,
        },
      });
    } catch (error) {
      this.logger.warn(
        `Ban on user ${after.userId} in community ${communityId} was revised, but the governance log entry could not be written: ${String(error)}.`,
      );
    }
    await this.governanceLog.logModerationAudit({
      actorUserId,
      action: COMMUNITY_BAN_AUDIT_ACTION,
      targetUserId: after.userId,
      note: after.reason,
      duration: after.expiresAt ? after.expiresAt.toISOString() : null,
    });
  }

  /**
   * Tell the barred member their ban changed, carrying the reason, the new end
   * date where there is one, and the rule it rests on.
   *
   * Best effort, like every other notify helper in this module: the revision
   * has already committed and a send failure must never surface as a failed
   * edit. No `actorId` is passed, so the bell never names which moderator
   * acted, matching the original ban notification.
   */
  private async notifyBanUpdated(
    community: Community,
    ban: CommunityBan,
  ): Promise<void> {
    try {
      await this.notifications.create(
        ban.userId,
        NotificationType.CommunityBanned,
        {
          source: 'community',
          communitySlug: community.slug,
          communityName: community.name,
          reason: ban.reason,
          expiresAt: ban.expiresAt?.toISOString() ?? null,
          ruleText: ban.ruleText,
          ruleIndex: ban.ruleIndex,
          ruleVersion: ban.ruleVersion,
        },
      );
    } catch {
      // Intentionally ignored: the revision already committed.
    }
  }
}
