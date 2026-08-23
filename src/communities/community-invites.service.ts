import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import {
  CommunityInviteSkipDTO,
  CommunityInviteSkipReason,
  CommunityInvitesResponseDTO,
} from './community-invites-response';
import { resolveStaffCommunity } from './community-staff-access';
import { CreateCommunityInvitesDto } from './dto/create-community-invites.dto';
import { CommunityBan } from './entities/community-ban.entity';
import {
  CommunityJoinRequest,
  JoinRequestStatus,
} from './entities/community-join-request.entity';
import { CommunityMember } from './entities/community-member.entity';
import { Community } from './entities/community.entity';

/**
 * Backs `POST /communities/:slug/invites` — inviting members to a community
 * that already exists.
 *
 * Until now `invites` was accepted only by `CreateCommunityDto` and is
 * explicitly rejected by `UpdateCommunityDto` (see `UpdateCommunityInput`'s
 * comment: founding-time invitations have no PATCH-time re-send semantics), so
 * the day a community was founded was the only day anyone could be invited to
 * it. Every community after that grew only by people finding it themselves.
 * This is the same invitation, available for the rest of the community's life.
 *
 * ## An invite is an invitation
 *
 * Nobody named here is added to the roster, and nothing here writes to
 * `community_members`. That is the module's standing rule (see
 * `CommunitiesService.resolveInvitees` and `NotificationType
 * .CommunityInviteReceived`: no consent-less roster adds), and it is the
 * whole reason a moderator-controlled invite endpoint is safe to expose. The
 * invitee still joins through the front door (`POST /communities/:slug/join`),
 * which is also what keeps a gated community's join review intact.
 *
 * The notification payload is byte-for-byte what
 * `CommunitiesService.notifyInvitees` sends at founding time
 * (`{ actorId, source: 'community', communitySlug }`), so the frontend's
 * existing handling of this type works unchanged.
 */
@Injectable()
export class CommunityInvitesService {
  constructor(
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly members: Repository<CommunityMember>,
    @InjectRepository(CommunityJoinRequest)
    private readonly joinRequests: Repository<CommunityJoinRequest>,
    @InjectRepository(CommunityBan)
    private readonly bans: Repository<CommunityBan>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Invite the named members (owner, co-owner or moderator).
   *
   * Every reason to pass someone over is per-slug and silent to that person:
   * they are reported back to the caller and never notified. Resolution is
   * batched, so the whole call is a fixed handful of queries whatever the
   * list's length.
   *
   * The notification write is deliberately NOT wrapped in a swallow-everything
   * try/catch, unlike the best-effort fan-outs elsewhere in this module. Those
   * sit after a row that has already committed and must not be rolled back by
   * a notification failure. Here the notification IS the invite: there is no
   * other side effect, so a failure has to reach the caller rather than be
   * reported back as a successful invitation nobody received.
   */
  async invite(
    slug: string,
    inviterUserId: string,
    dto: CreateCommunityInvitesDto,
  ): Promise<CommunityInvitesResponseDTO> {
    const { community } = await resolveStaffCommunity(
      this.communities,
      this.members,
      slug,
      inviterUserId,
    );

    // Dedupe while keeping the caller's order, so the summary reads back in
    // the order they typed and a slug listed twice is answered once.
    const requestedSlugs = [...new Set(dto.memberSlugs.map((s) => s.trim()))];

    const userIdBySlug = await new MemberLookup(this.profiles).userIdsForSlugs(
      requestedSlugs,
    );
    const resolvedUserIds = [...new Set(userIdBySlug.values())];

    const [systemUserIds, memberUserIds, pendingUserIds, bannedUserIds] =
      await Promise.all([
        this.systemUserIds(resolvedUserIds),
        this.rosterUserIds(community.id, resolvedUserIds),
        this.pendingRequestUserIds(community.id, resolvedUserIds),
        this.bannedUserIds(community.id, resolvedUserIds),
      ]);

    const invitedSlugs: string[] = [];
    const invitedUserIds: string[] = [];
    const skipped: CommunityInviteSkipDTO[] = [];

    for (const memberSlug of requestedSlugs) {
      const userId = userIdBySlug.get(memberSlug);
      const reason = this.skipReasonFor(
        userId,
        inviterUserId,
        systemUserIds,
        memberUserIds,
        pendingUserIds,
        bannedUserIds,
      );
      if (reason || !userId) {
        skipped.push({
          slug: memberSlug,
          reason: reason ?? CommunityInviteSkipReason.UnknownMember,
        });
        continue;
      }
      invitedSlugs.push(memberSlug);
      invitedUserIds.push(userId);
    }

    if (invitedUserIds.length) {
      await this.notifications.createForRecipients(
        invitedUserIds,
        NotificationType.CommunityInviteReceived,
        {
          actorId: inviterUserId,
          source: 'community',
          communitySlug: community.slug,
        },
        inviterUserId,
      );
    }

    return {
      invited: invitedSlugs,
      skipped,
      invitedCount: invitedSlugs.length,
      skippedCount: skipped.length,
    };
  }

  /**
   * The first reason this member cannot be invited, or `null` when they can.
   * Ordered so the most informative answer wins: "already in the room" is
   * more use to an owner than "they also have a pending request".
   */
  private skipReasonFor(
    userId: string | undefined,
    inviterUserId: string,
    systemUserIds: Set<string>,
    memberUserIds: Set<string>,
    pendingUserIds: Set<string>,
    bannedUserIds: Set<string>,
  ): CommunityInviteSkipReason | null {
    if (!userId) return CommunityInviteSkipReason.UnknownMember;
    if (userId === inviterUserId) return CommunityInviteSkipReason.Self;
    if (systemUserIds.has(userId)) {
      return CommunityInviteSkipReason.SystemAccount;
    }
    if (memberUserIds.has(userId)) {
      return CommunityInviteSkipReason.AlreadyMember;
    }
    if (bannedUserIds.has(userId)) return CommunityInviteSkipReason.Banned;
    if (pendingUserIds.has(userId)) {
      return CommunityInviteSkipReason.PendingJoinRequest;
    }
    return null;
  }

  /**
   * House/system accounts among the resolved ids. Same guardrail
   * `CommunitiesService.resolveInvitees` applies at founding time: a system
   * account is never invited anywhere.
   */
  private async systemUserIds(userIds: string[]): Promise<Set<string>> {
    if (!userIds.length) return new Set<string>();
    const rows = await this.users.find({
      where: { id: In(userIds), isSystem: true },
      select: { id: true },
    });
    return new Set(rows.map((row) => row.id));
  }

  private async rosterUserIds(
    communityId: string,
    userIds: string[],
  ): Promise<Set<string>> {
    if (!userIds.length) return new Set<string>();
    const rows = await this.members.find({
      where: { communityId, userId: In(userIds) },
      select: { userId: true },
    });
    return new Set(rows.map((row) => row.userId));
  }

  private async pendingRequestUserIds(
    communityId: string,
    userIds: string[],
  ): Promise<Set<string>> {
    if (!userIds.length) return new Set<string>();
    const rows = await this.joinRequests.find({
      where: {
        communityId,
        userId: In(userIds),
        status: JoinRequestStatus.Pending,
      },
      select: { userId: true },
    });
    return new Set(rows.map((row) => row.userId));
  }

  /**
   * Members barred from this community (`community_bans`). A ban outlives the
   * roster row precisely so a removed member cannot walk back in, and an
   * invite would be exactly that door reopening.
   */
  private async bannedUserIds(
    communityId: string,
    userIds: string[],
  ): Promise<Set<string>> {
    if (!userIds.length) return new Set<string>();
    const rows = await this.bans.find({
      where: { communityId, userId: In(userIds) },
      select: { userId: true },
    });
    return new Set(rows.map((row) => row.userId));
  }
}
