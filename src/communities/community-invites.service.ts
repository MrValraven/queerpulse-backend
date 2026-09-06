import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, MoreThan, Repository } from 'typeorm';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { CommunitiesService } from './communities.service';
import {
  CommunityInviteSkipDTO,
  CommunityInviteSkipReason,
  CommunityInvitesResponseDTO,
  CommunityPendingInviteDTO,
  MyCommunityInviteDTO,
  toCommunityPendingInvite,
  toMyCommunityInvite,
} from './community-invites-response';
import { resolveStaffCommunity } from './community-staff-access';
import { CreateCommunityInvitesDto } from './dto/create-community-invites.dto';
import { CommunityBan } from './entities/community-ban.entity';
import {
  CommunityInvite,
  CommunityInviteStatus,
} from './entities/community-invite.entity';
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
// The columns `RETURNING *` surfaces for a freshly inserted invitation.
// Postgres returns its own (snake_case) column names, so this reads
// `invited_user_id`, never the camelCase entity property. Mirrors
// `EventInvitesService`'s `InsertedInviteRow`.
interface InsertedInviteRow {
  id: string;
  invited_user_id: string;
}

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
    @InjectRepository(CommunityInvite)
    private readonly invites: Repository<CommunityInvite>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly notifications: NotificationsService,
    // A community taken down by platform moderation 404s its detail, so an
    // invitation to one is a dead end and `listMine` drops it.
    private readonly contentModeration: ContentModerationService,
    // Renders the community on the invitee's own invitations shelf as the
    // ordinary discover-grid card, with the stats batched across the whole
    // list (`cardsByCommunityId`). No cycle: `CommunitiesService` injects
    // repositories and leaf services only, never this one.
    private readonly communitiesService: CommunitiesService,
  ) {}

  /**
   * Invite the named members (owner, co-owner or moderator).
   *
   * Every reason to pass someone over is per-slug and silent to that person:
   * they are reported back to the caller and never notified. Resolution is
   * batched, so the whole call is a fixed handful of queries whatever the
   * list's length.
   *
   * ## The row is the invitation, the notification announces it
   *
   * This used to send a bell and write nothing (PRD-140), which meant an
   * invitation existed only in a notification list and gated nothing: a
   * `private` community 404ed its own invitee, and an `invite`-tier one let
   * anybody at all queue up a join request. Each invitee now gets a pending
   * `CommunityInvite`, and that row is what `CommunitiesService.getBySlug` and
   * `join` read as the door gate.
   *
   * THE ROWS ARE WRITTEN FIRST, then the bells. The old comment here said the
   * notification IS the invite and so must not be swallowed, and the second
   * half of that still holds: a notification failure reaches the caller rather
   * than being reported back as an invitation nobody received. What changed is
   * which write must survive. On a notification failure the invitations stand,
   * and they stand somewhere their holders can find them: they are listed by
   * `GET /me/community-invites`, so the invitation is never lost, only
   * unannounced. The reverse order would trade that for the failure this whole
   * row exists to end, an invitee holding a bell that leads to a 404.
   *
   * `ON CONFLICT DO NOTHING` + `RETURNING` means the notification goes to
   * exactly the people who got a NEW invitation. Somebody who already held a
   * pending one is reported back as `already_invited` and hears nothing: a
   * second bell every time a moderator re-opens the invite panel is a nudge
   * nobody agreed to. That covers the race between two moderators inviting the
   * same person at once, as well as the ordinary re-invite.
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

    const [
      systemUserIds,
      memberUserIds,
      pendingUserIds,
      bannedUserIds,
      invitedAlreadyUserIds,
    ] = await Promise.all([
      this.systemUserIds(resolvedUserIds),
      this.rosterUserIds(community.id, resolvedUserIds),
      this.pendingRequestUserIds(community.id, resolvedUserIds),
      this.bannedUserIds(community.id, resolvedUserIds),
      this.pendingInviteUserIds(community.id, resolvedUserIds),
    ]);

    // First pass: the reason each named slug was passed over, or nothing when
    // they are invitable. The insert below can add one more (`already_invited`
    // from a lost race), so the answer per slug is settled after it.
    const skipReasonBySlug = new Map<string, CommunityInviteSkipReason>();
    const candidateUserIds: string[] = [];
    for (const memberSlug of requestedSlugs) {
      const userId = userIdBySlug.get(memberSlug);
      const reason = this.skipReasonFor(
        userId,
        inviterUserId,
        systemUserIds,
        memberUserIds,
        pendingUserIds,
        bannedUserIds,
        invitedAlreadyUserIds,
      );
      if (reason || !userId) {
        skipReasonBySlug.set(
          memberSlug,
          reason ?? CommunityInviteSkipReason.UnknownMember,
        );
        continue;
      }
      candidateUserIds.push(userId);
    }

    const insertedUserIds = await this.recordInvites(
      community.id,
      inviterUserId,
      candidateUserIds,
    );

    // Second pass, in the caller's own order: an invitation that lost the
    // race to a concurrent one is reported as `already_invited`, which is the
    // truth about it.
    const invitedSlugs: string[] = [];
    const invitedUserIds: string[] = [];
    const skipped: CommunityInviteSkipDTO[] = [];
    for (const memberSlug of requestedSlugs) {
      const reason = skipReasonBySlug.get(memberSlug);
      if (reason) {
        skipped.push({ slug: memberSlug, reason });
        continue;
      }
      const userId = userIdBySlug.get(memberSlug);
      if (!userId || !insertedUserIds.has(userId)) {
        skipped.push({
          slug: memberSlug,
          reason: CommunityInviteSkipReason.AlreadyInvited,
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
          // PRD-140. Kept byte-for-byte identical to the founding-time payload
          // in `CommunitiesService.notifyInvitees`, including the name, so one
          // piece of client copy renders both.
          communityName: community.name,
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
    invitedAlreadyUserIds: Set<string>,
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
    // Last, being the least surprising of the six: the invitation this owner
    // is trying to send is already sitting in that member's list.
    if (invitedAlreadyUserIds.has(userId)) {
      return CommunityInviteSkipReason.AlreadyInvited;
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
    // An array of `where` objects is TypeORM's OR. A ban with no `expiresAt`
    // is permanent; a timed one stops barring the member the moment it lapses,
    // so an expired row must not keep somebody un-invitable forever.
    const rows = await this.bans.find({
      where: [
        { communityId, userId: In(userIds), expiresAt: IsNull() },
        { communityId, userId: In(userIds), expiresAt: MoreThan(new Date()) },
      ],
      select: { userId: true },
    });
    return new Set(rows.map((row) => row.userId));
  }

  /**
   * Members who already hold a pending invitation to this community. Read
   * against the same partial index the insert conflicts on
   * (`UQ_community_invites_pending`), so the pre-check and the race guard
   * agree by construction.
   */
  private async pendingInviteUserIds(
    communityId: string,
    userIds: string[],
  ): Promise<Set<string>> {
    if (!userIds.length) return new Set<string>();
    const rows = await this.invites.find({
      where: {
        communityId,
        invitedUserId: In(userIds),
        status: CommunityInviteStatus.Pending,
      },
      select: { invitedUserId: true },
    });
    return new Set(rows.map((row) => row.invitedUserId));
  }

  /**
   * Write one pending invitation per named member and report back WHOSE was
   * actually written. `ON CONFLICT DO NOTHING` + `RETURNING` gives Postgres
   * the last word: the rows that come back are exactly the new invitations,
   * so nobody who already held one is announced a second time. Mirrors
   * `EventInvitesService.createInvites`'s idiom.
   */
  private async recordInvites(
    communityId: string,
    inviterUserId: string,
    invitedUserIds: string[],
  ): Promise<Set<string>> {
    if (!invitedUserIds.length) return new Set<string>();
    const result = await this.invites
      .createQueryBuilder()
      .insert()
      .into(CommunityInvite)
      .values(
        invitedUserIds.map((invitedUserId) => ({
          communityId,
          invitedUserId,
          invitedByUserId: inviterUserId,
          status: CommunityInviteStatus.Pending,
        })),
      )
      .orIgnore()
      .returning('*')
      .execute();
    const rows = (result.raw as InsertedInviteRow[] | undefined) ?? [];
    return new Set(rows.map((row) => row.invited_user_id));
  }

  /**
   * `GET /me/community-invites` — the caller's own standing invitations,
   * newest first.
   *
   * A stale invitation is the bug this endpoint exists to avoid, so four
   * kinds are filtered out rather than listed as decisions somebody still has
   * to make: a community that has since been ARCHIVED or TAKEN DOWN (both
   * 404 the detail, so the card would lead nowhere), one the caller has since
   * JOINED by another door, and one they have since been BANNED from (a ban
   * outlives the invitation on purpose). The rows are left alone in every
   * case: a community that is unarchived or restored has its invitations back
   * exactly as they were, and nothing here quietly answers on the member's
   * behalf.
   */
  async listMine(userId: string): Promise<{ items: MyCommunityInviteDTO[] }> {
    const invites = await this.invites.find({
      where: { invitedUserId: userId, status: CommunityInviteStatus.Pending },
      order: { createdAt: 'DESC' },
    });
    if (!invites.length) return { items: [] };

    const communityIds = [...new Set(invites.map((row) => row.communityId))];
    const communities = await this.communities.find({
      where: { id: In(communityIds), archivedAt: IsNull() },
    });
    const [rosterRows, bannedFromIds, moderationStates] = await Promise.all([
      this.members.find({
        where: { communityId: In(communityIds), userId },
        select: { communityId: true },
      }),
      this.bannedFromCommunityIds(communityIds, userId),
      // Keyed by SLUG under the `community` subject type, matching
      // `CommunitiesService.SUBJECT_TYPE` and the report `subjectId`.
      this.contentModeration.statesFor(
        'community',
        communities.map((community) => community.slug),
      ),
    ]);
    const joinedIds = new Set(rosterRows.map((row) => row.communityId));

    const liveCommunities = communities.filter((community) => {
      if (joinedIds.has(community.id)) return false;
      if (bannedFromIds.has(community.id)) return false;
      const moderation = moderationStates.get(community.slug);
      return !moderation?.hidden && !moderation?.removed;
    });
    const communityById = new Map(
      liveCommunities.map((community) => [community.id, community]),
    );
    const listable = invites.filter((invite) =>
      communityById.has(invite.communityId),
    );
    if (!listable.length) return { items: [] };

    const [cards, inviterRefs] = await Promise.all([
      this.communitiesService.cardsByCommunityId(liveCommunities, userId),
      this.inviterRefs(listable),
    ]);

    const items: MyCommunityInviteDTO[] = [];
    for (const invite of listable) {
      const card = cards.get(invite.communityId);
      if (!card) continue;
      items.push(
        toMyCommunityInvite(
          invite,
          card,
          invite.invitedByUserId
            ? (inviterRefs.get(invite.invitedByUserId) ?? null)
            : null,
        ),
      );
    }
    return { items };
  }

  /**
   * `DELETE /me/community-invites/:id` — the invitee declines.
   *
   * Nobody is told. `declined` is the member's own answer and the one status
   * this module never surfaces to a community's moderators as anything but
   * "no longer pending" (see `CommunityInviteStatus`): saying no to a
   * survivors' or coming-out group must not become a notification the room
   * can read. The row stays for the partial unique index's sake, so the
   * community can invite again later if it chooses.
   */
  async declineMine(inviteId: string, userId: string): Promise<void> {
    const invite = await this.invites.findOne({ where: { id: inviteId } });
    if (!invite) {
      throw new NotFoundException('Invitation not found');
    }
    if (invite.invitedUserId !== userId) {
      // 403, not 404: the caller reached a real invitation id that simply is
      // not theirs, and this endpoint is scoped to the caller either way.
      throw new ForbiddenException('This invitation is not addressed to you');
    }
    if (invite.status !== CommunityInviteStatus.Pending) {
      throw new ConflictException('This invitation has already been answered');
    }
    invite.status = CommunityInviteStatus.Declined;
    invite.respondedAt = new Date();
    await this.invites.save(invite);
  }

  /**
   * `GET /communities/:slug/invites` — the community's own PENDING
   * invitations (owner, co-owner or moderator).
   *
   * Pending only, and an invitee who has since landed on the roster by
   * another door is dropped: what a moderator needs from this list is who is
   * still standing outside with a door held open for them.
   */
  async listPending(
    slug: string,
    actorUserId: string,
  ): Promise<{ items: CommunityPendingInviteDTO[] }> {
    const { community } = await resolveStaffCommunity(
      this.communities,
      this.members,
      slug,
      actorUserId,
    );
    const invites = await this.invites.find({
      where: {
        communityId: community.id,
        status: CommunityInviteStatus.Pending,
      },
      order: { createdAt: 'DESC' },
    });
    if (!invites.length) return { items: [] };

    const invitedUserIds = invites.map((invite) => invite.invitedUserId);
    const [rosterRows, memberRefs, inviterRefs] = await Promise.all([
      this.members.find({
        where: { communityId: community.id, userId: In(invitedUserIds) },
        select: { userId: true },
      }),
      new MemberLookup(this.profiles).byUserIds(invitedUserIds),
      this.inviterRefs(invites),
    ]);
    const joinedUserIds = new Set(rosterRows.map((row) => row.userId));

    const items: CommunityPendingInviteDTO[] = [];
    for (const invite of invites) {
      if (joinedUserIds.has(invite.invitedUserId)) continue;
      const member = memberRefs.get(invite.invitedUserId);
      // An invitee with no profile row cannot be rendered at all, the same
      // filter `CommunitiesService.listJoinRequests` applies to its queue.
      if (!member) continue;
      items.push(
        toCommunityPendingInvite(
          invite,
          member,
          invite.invitedByUserId
            ? (inviterRefs.get(invite.invitedByUserId) ?? null)
            : null,
        ),
      );
    }
    return { items };
  }

  /**
   * `DELETE /communities/:slug/invites/:id` — a moderator withdraws an
   * invitation before it was answered.
   *
   * REVOCATION IS SILENT, deliberately: no notification is sent, and the
   * invitation simply stops being listed. Telling somebody "you have been
   * uninvited" from a survivors' or coming-out group is worse than saying
   * nothing, and there is no version of that message that reads as anything
   * but a rejection they never asked to hear about. Please do not "fix" this
   * by adding a bell.
   *
   * The UPDATE is guarded on the row still being pending, so a revoke racing
   * the invitee's own accept cannot overwrite it: the accept
   * (`CommunitiesService.acceptInvite`) claims the row under the same guard,
   * and whichever lands first wins outright.
   */
  async revoke(
    slug: string,
    inviteId: string,
    actorUserId: string,
  ): Promise<void> {
    const { community } = await resolveStaffCommunity(
      this.communities,
      this.members,
      slug,
      actorUserId,
    );
    const invite = await this.invites.findOne({
      where: { id: inviteId, communityId: community.id },
    });
    if (!invite) {
      throw new NotFoundException('Invitation not found');
    }
    const claim = await this.invites
      .createQueryBuilder()
      .update(CommunityInvite)
      .set({
        status: CommunityInviteStatus.Revoked,
        respondedAt: () => 'now()',
        revokedByUserId: actorUserId,
      })
      .where('id = :id AND status = :pending', {
        id: invite.id,
        pending: CommunityInviteStatus.Pending,
      })
      .execute();
    if (claim.affected === 0) {
      throw new ConflictException('This invitation has already been answered');
    }
  }

  /** The moderators who sent this page of invitations, batched to one query. */
  private async inviterRefs(
    invites: CommunityInvite[],
  ): Promise<Map<string, MemberRef>> {
    const inviterUserIds = [
      ...new Set(
        invites
          .map((invite) => invite.invitedByUserId)
          .filter((userId): userId is string => userId !== null),
      ),
    ];
    return new MemberLookup(this.profiles).byUserIds(inviterUserIds);
  }

  /**
   * Which of these communities currently bar this member. Same live-ban
   * predicate `bannedUserIds` uses (a lapsed timed ban bars nobody), read the
   * other way round: one member across many communities.
   */
  private async bannedFromCommunityIds(
    communityIds: string[],
    userId: string,
  ): Promise<Set<string>> {
    if (!communityIds.length) return new Set<string>();
    const rows = await this.bans.find({
      where: [
        { communityId: In(communityIds), userId, expiresAt: IsNull() },
        {
          communityId: In(communityIds),
          userId,
          expiresAt: MoreThan(new Date()),
        },
      ],
      select: { communityId: true },
    });
    return new Set(rows.map((row) => row.communityId));
  }
}
