import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { CommunityGovernanceLogService } from '../communities/community-governance-log.service';
import { GovernanceLogAction } from '../communities/entities/community-governance-log.entity';
import {
  CommunityMember,
  RosterRole,
} from '../communities/entities/community-member.entity';
import { Community } from '../communities/entities/community.entity';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import {
  AdminCommunityModeratorDTO,
  toAdminModerator,
} from './admin-communities-response';
import {
  AdminModeratorCandidateDTO,
  toModeratorCandidate,
} from './admin-community-moderators-response';

/** Roster roles that count as moderation staff — the owner (founder) plus any
 *  promoted moderators. Mirrors `AdminCommunitiesService`'s own constant. */
const MODERATOR_ROLES = [RosterRole.Owner, RosterRole.Mod];

/**
 * Write model behind the admin communities panel's moderator controls
 * (`AdminCommunitySettings` add/remove). Kept separate from the read-only
 * `AdminCommunitiesService` so the dashboard's health math stays a pure read
 * model and the mutations live behind their own controller.
 *
 * A moderator is always a *promotion of an existing roster member*: the
 * community's `owner` role (the founder, the source of truth for which is
 * `Community.ownerId`) is immovable here, and a plain `member` is toggled
 * between `member` and `mod`. No route in this service can create, remove, or
 * reassign the owner — mirroring the invariants `CommunitiesService.setMemberRole`
 * already enforces on the community-owned mod panel.
 */
@Injectable()
export class AdminCommunityModeratorsService {
  private readonly logger = new Logger(AdminCommunityModeratorsService.name);

  constructor(
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly communityMembers: Repository<CommunityMember>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    // BE-COM-19 — a platform-staff promotion/demotion mutates the same roster
    // column the community-owned path writes, so it belongs in the same
    // `community_governance_log` trail (with `adminOverride: true`) and owes
    // the member the same `CommunityRoleChanged` notification. Both were
    // missing entirely: only the member-facing `CommunitiesService.setMemberRole`
    // logged and notified.
    private readonly governanceLog: CommunityGovernanceLogService,
    private readonly notifications: NotificationsService,
  ) {}

  /** The community's current moderation staff (owner + mods), oldest first. */
  async listModerators(slug: string): Promise<AdminCommunityModeratorDTO[]> {
    const community = await this.loadOr404(slug);
    return this.moderatorsFor(community.id);
  }

  /**
   * The plain members eligible to be promoted — everyone on the roster who is
   * not already the owner or a moderator. Backs the add-moderator picker.
   */
  async listCandidates(slug: string): Promise<AdminModeratorCandidateDTO[]> {
    const community = await this.loadOr404(slug);
    const candidateMembers = await this.communityMembers.find({
      where: { communityId: community.id, role: RosterRole.Member },
      order: { joinedAt: 'ASC' },
    });
    if (!candidateMembers.length) return [];

    const memberRefsByUserId = await new MemberLookup(this.profiles).byUserIds(
      candidateMembers.map((candidateMember) => candidateMember.userId),
    );

    const candidates: AdminModeratorCandidateDTO[] = [];
    for (const candidateMember of candidateMembers) {
      const memberRef = memberRefsByUserId.get(candidateMember.userId);
      // A roster row with no profile is a data-integrity anomaly, not a
      // legitimate candidate — drop it rather than offer an unnameable member.
      if (!memberRef) continue;
      candidates.push(toModeratorCandidate(candidateMember.userId, memberRef));
    }
    return candidates;
  }

  /**
   * Promote a roster member to moderator.
   *
   *  - 404 if `memberId` is not on this community's roster (a moderator is a
   *    promotion of an existing member, never a way to force-add someone).
   *  - 400 if the target is the owner — the founder is already the community's
   *    root moderator and their role is immovable (see the class doc).
   *  - Idempotent: re-adding an existing moderator is a no-op that returns the
   *    current moderator, matching this codebase's posture on join / triage /
   *    `setMemberRole`.
   */
  async addModerator(
    slug: string,
    memberId: string,
    actorUserId: string,
  ): Promise<AdminCommunityModeratorDTO> {
    const community = await this.loadOr404(slug);
    const membership = await this.membershipOr404(community.id, memberId);

    if (membership.role === RosterRole.Owner) {
      throw new BadRequestException(
        'The founder is already this community’s moderator.',
      );
    }

    if (membership.role !== RosterRole.Mod) {
      const fromRole = membership.role;
      membership.role = RosterRole.Mod;
      await this.communityMembers.save(membership);
      // Only on a real transition — re-adding an existing moderator is an
      // idempotent no-op, and a no-op belongs in neither the audit trail nor
      // the member's notification feed.
      await this.logRoleChange(
        community,
        actorUserId,
        memberId,
        fromRole,
        RosterRole.Mod,
      );
    }

    return this.moderatorDtoFor(membership);
  }

  /**
   * Demote a moderator back to a plain member.
   *
   *  - 404 if `memberId` is not on this community's roster.
   *  - 400 if the target is the owner — the founder cannot be removed as a
   *    moderator, so a community can never be left without one (this is the
   *    "last owner/founder" guard: there is exactly one owner, fixed by
   *    `Community.ownerId`, and it is never touched here).
   *  - 400 if the target is a plain member — there is no moderator to remove.
   */
  async removeModerator(
    slug: string,
    memberId: string,
    actorUserId: string,
  ): Promise<void> {
    const community = await this.loadOr404(slug);
    const membership = await this.membershipOr404(community.id, memberId);

    if (membership.role === RosterRole.Owner) {
      throw new BadRequestException(
        'The founder cannot be removed as a moderator.',
      );
    }
    if (membership.role !== RosterRole.Mod) {
      throw new BadRequestException('That member is not a moderator.');
    }

    membership.role = RosterRole.Member;
    await this.communityMembers.save(membership);
    await this.logRoleChange(
      community,
      actorUserId,
      memberId,
      RosterRole.Mod,
      RosterRole.Member,
    );
  }

  /**
   * Records a platform-staff role change in `community_governance_log` and
   * tells the member, mirroring what `CommunitiesService.setMemberRole` does
   * on the community-owned path. `adminOverride: true` is what distinguishes
   * the two in the trail.
   *
   * Both writes are best-effort: the role change itself has already
   * committed, so neither a log failure nor a notification failure should
   * turn a successful mutation into a 500 (same posture as
   * `CommunitiesService.notifyRoleChanged`). A log failure is at least
   * surfaced in the server log rather than lost.
   */
  private async logRoleChange(
    community: Community,
    actorUserId: string,
    targetUserId: string,
    fromRole: RosterRole,
    toRole: RosterRole,
  ): Promise<void> {
    try {
      await this.governanceLog.log({
        communityId: community.id,
        actorUserId,
        action: GovernanceLogAction.RoleChanged,
        targetUserId,
        metadata: { adminOverride: true, fromRole, toRole },
      });
    } catch (error) {
      this.logger.warn(
        `Failed to write the governance-log row for the ${fromRole} to ${toRole} change on ${community.slug}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    try {
      await this.notifications.create(
        targetUserId,
        NotificationType.CommunityRoleChanged,
        {
          actorId: actorUserId,
          source: 'community',
          communitySlug: community.slug,
          fromRole,
          toRole,
        },
        actorUserId,
      );
    } catch {
      // Intentionally ignored — best-effort; the role change already committed.
    }
  }

  // --- internals ---

  private async loadOr404(slug: string): Promise<Community> {
    const community = await this.communities.findOne({ where: { slug } });
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    return community;
  }

  private async membershipOr404(
    communityId: string,
    userId: string,
  ): Promise<CommunityMember> {
    const membership = await this.communityMembers.findOne({
      where: { communityId, userId },
    });
    if (!membership) {
      throw new NotFoundException('Member not found on this community roster');
    }
    return membership;
  }

  /** Maps a single moderation-staff membership to its DTO, resolving the
   *  profile. Throws if the profile is missing (a data-integrity anomaly the
   *  admin surface should surface loudly, not swallow). */
  private async moderatorDtoFor(
    membership: CommunityMember,
  ): Promise<AdminCommunityModeratorDTO> {
    const memberRef = (
      await new MemberLookup(this.profiles).byUserIds([membership.userId])
    ).get(membership.userId);
    if (!memberRef) {
      throw new NotFoundException('Member profile not found');
    }
    return toAdminModerator(
      membership.userId,
      memberRef,
      membership.role === RosterRole.Owner ? 'owner' : 'mod',
      membership.joinedAt,
    );
  }

  private async moderatorsFor(
    communityId: string,
  ): Promise<AdminCommunityModeratorDTO[]> {
    const moderatorMembers = await this.communityMembers.find({
      where: { communityId, role: In(MODERATOR_ROLES) },
      order: { joinedAt: 'ASC' },
    });
    if (!moderatorMembers.length) return [];

    const memberRefsByUserId = await new MemberLookup(this.profiles).byUserIds(
      moderatorMembers.map((moderatorMember) => moderatorMember.userId),
    );

    const moderators: AdminCommunityModeratorDTO[] = [];
    for (const moderatorMember of moderatorMembers) {
      const memberRef = memberRefsByUserId.get(moderatorMember.userId);
      if (!memberRef) {
        this.logger.warn(
          `Community ${communityId} has a ${moderatorMember.role} (user ${moderatorMember.userId}) with no profile row; omitting from the moderator list.`,
        );
        continue;
      }
      moderators.push(
        toAdminModerator(
          moderatorMember.userId,
          memberRef,
          moderatorMember.role === RosterRole.Owner ? 'owner' : 'mod',
          moderatorMember.joinedAt,
        ),
      );
    }
    return moderators;
  }
}
