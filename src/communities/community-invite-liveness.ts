import { ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';
import { COMMUNITY_STAFF_ROLES } from './community-staff-access';
import {
  CommunityInvite,
  CommunityInviteStatus,
} from './entities/community-invite.entity';

/**
 * The single definition of "an invitation that can still be spent"
 * (ENG-425, ENG-429).
 *
 * A `pending` status alone says only that nobody answered the invitation. It
 * can still be dead three ways: it lapsed (`expires_at`), the moderator who
 * sent it has since left the community's staff, or one of the two people has
 * blocked the other. Every reader that asks "does this person hold an
 * invitation" goes through `whereInviteIsLive`, so the door gate, the
 * invitee's shelf, the staff list and the re-invite check all agree. Readers
 * filter through this module and leave a bare `status = 'pending'` check
 * behind.
 *
 * Plain functions taking the caller's own repository, the same shape
 * `community-staff-access.ts` uses, so no DI registration is needed.
 */

/** How long an invitation stays spendable after it is sent. Mirrors the
 *  column default in `1823910000000-AddCommunityInviteExpiry`. */
export const COMMUNITY_INVITE_TTL_DAYS = 30;

export interface LiveInviteScopeOptions {
  /** Drop invitations whose inviter and invitee block each other either way.
   *  Defaults to true, and every current reader keeps the default. */
  shouldHonourBlocks?: boolean;
}

const LIVE_INVITE_ALIAS = 'live_invite';

/** Narrows a query over `community_invites` (aliased `alias`) to invitations
 *  that can still be spent: pending, unexpired, sent by someone who still
 *  holds a staff role in the community or its parent (a NULL inviter, an
 *  erased account, stays valid), and with no block between the two people. */
export function whereInviteIsLive<Entity extends ObjectLiteral>(
  queryBuilder: SelectQueryBuilder<Entity>,
  alias: string,
  options: LiveInviteScopeOptions = {},
): SelectQueryBuilder<Entity> {
  const shouldHonourBlocks = options.shouldHonourBlocks ?? true;
  queryBuilder
    .andWhere(`"${alias}"."status" = :liveInvitePendingStatus`, {
      liveInvitePendingStatus: CommunityInviteStatus.Pending,
    })
    .andWhere(`"${alias}"."expires_at" > now()`)
    .andWhere(
      `("${alias}"."invited_by_user_id" IS NULL OR EXISTS (
        SELECT 1 FROM "community_members" "inviter_member"
        INNER JOIN "communities" "invite_community"
          ON "invite_community"."id" = "${alias}"."community_id"
        WHERE "inviter_member"."user_id" = "${alias}"."invited_by_user_id"
          AND "inviter_member"."role" IN (:...liveInviteStaffRoles)
          AND ("inviter_member"."community_id" = "${alias}"."community_id"
            OR "inviter_member"."community_id" = "invite_community"."parent_id")))`,
      { liveInviteStaffRoles: [...COMMUNITY_STAFF_ROLES] },
    );
  if (shouldHonourBlocks) {
    queryBuilder.andWhere(
      `NOT EXISTS (SELECT 1 FROM "blocks" "invite_block"
        WHERE ("invite_block"."blocker_id" = "${alias}"."invited_user_id"
            AND "invite_block"."blocked_id" = "${alias}"."invited_by_user_id")
           OR ("invite_block"."blocker_id" = "${alias}"."invited_by_user_id"
            AND "invite_block"."blocked_id" = "${alias}"."invited_user_id"))`,
    );
  }
  return queryBuilder;
}

/** One person's invitations to one community, narrowed to the live ones. */
function liveInvitesForPersonQuery(
  invites: Repository<CommunityInvite>,
  communityId: string,
  invitedUserId: string,
): SelectQueryBuilder<CommunityInvite> {
  return whereInviteIsLive(
    invites
      .createQueryBuilder(LIVE_INVITE_ALIAS)
      .where(`"${LIVE_INVITE_ALIAS}"."community_id" = :communityId`, {
        communityId,
      })
      .andWhere(`"${LIVE_INVITE_ALIAS}"."invited_user_id" = :invitedUserId`, {
        invitedUserId,
      }),
    LIVE_INVITE_ALIAS,
  );
}

export function findLivePendingInvite(
  invites: Repository<CommunityInvite>,
  communityId: string,
  invitedUserId: string,
): Promise<CommunityInvite | null> {
  return liveInvitesForPersonQuery(
    invites,
    communityId,
    invitedUserId,
  ).getOne();
}

export function hasLivePendingInvite(
  invites: Repository<CommunityInvite>,
  communityId: string,
  invitedUserId: string,
): Promise<boolean> {
  return liveInvitesForPersonQuery(
    invites,
    communityId,
    invitedUserId,
  ).getExists();
}

/** The invitee's live invitations across all communities, newest first. */
export function livePendingInvitesForInvitee(
  invites: Repository<CommunityInvite>,
  invitedUserId: string,
): Promise<CommunityInvite[]> {
  return whereInviteIsLive(
    invites
      .createQueryBuilder(LIVE_INVITE_ALIAS)
      .where(`"${LIVE_INVITE_ALIAS}"."invited_user_id" = :invitedUserId`, {
        invitedUserId,
      }),
    LIVE_INVITE_ALIAS,
  )
    .orderBy(`"${LIVE_INVITE_ALIAS}"."created_at"`, 'DESC')
    .getMany();
}

export async function liveInvitedUserIds(
  invites: Repository<CommunityInvite>,
  communityId: string,
  userIds: string[],
  options?: LiveInviteScopeOptions,
): Promise<Set<string>> {
  if (!userIds.length) return new Set<string>();
  const rows = await whereInviteIsLive(
    invites
      .createQueryBuilder(LIVE_INVITE_ALIAS)
      .select(`"${LIVE_INVITE_ALIAS}"."invited_user_id"`, 'invitedUserId')
      .where(`"${LIVE_INVITE_ALIAS}"."community_id" = :communityId`, {
        communityId,
      })
      .andWhere(`"${LIVE_INVITE_ALIAS}"."invited_user_id" IN (:...userIds)`, {
        userIds,
      }),
    LIVE_INVITE_ALIAS,
    options,
  ).getRawMany<{ invitedUserId: string }>();
  return new Set(rows.map((row) => row.invitedUserId));
}

/** Flips every remaining `pending` row for these people in this community to
 *  `revoked` (responded_at = now(), revoked_by_user_id stays NULL). Call only
 *  for people who hold no LIVE invitation, so every row it touches is dead. */
export async function retireDeadPendingInvites(
  invites: Repository<CommunityInvite>,
  communityId: string,
  userIds: string[],
): Promise<void> {
  if (!userIds.length) return;
  await invites
    .createQueryBuilder()
    .update(CommunityInvite)
    .set({
      status: CommunityInviteStatus.Revoked,
      respondedAt: () => 'now()',
    })
    .where(
      'community_id = :communityId AND invited_user_id IN (:...userIds) AND status = :pending',
      { communityId, userIds, pending: CommunityInviteStatus.Pending },
    )
    .execute();
}
