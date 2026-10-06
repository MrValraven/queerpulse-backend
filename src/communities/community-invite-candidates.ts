import { Repository, SelectQueryBuilder } from 'typeorm';
import { escapeLikeTerm } from '../common/like-escape';
import { MemberRef, toMemberRef } from '../common/member-ref';
import { PAGE_SIZE, Paginated } from '../common/pagination';
import {
  CONNECTION_SEARCH_HAYSTACK,
  foldedTextExpression,
} from '../connections/connection-search';
import {
  Connection,
  ConnectionStatus,
} from '../connections/entities/connection.entity';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { whereInviteIsLive } from './community-invite-liveness';
import { CommunityInvite } from './entities/community-invite.entity';
import { JoinRequestStatus } from './entities/community-join-request.entity';
import { Community } from './entities/community.entity';

/**
 * Who a community's staff can invite right now, searched and paged in SQL
 * (`GET /communities/:slug/invites/candidates`).
 *
 * The list is the inviter's own ACCEPTED connections, narrowed to exactly the
 * people `CommunityInvitesService.invite` would answer "invited" for. Each
 * `WHERE` below mirrors one `skipReasonFor` reason, so a name the panel offers
 * is never one the send then passes over:
 *
 *  - `unknown_member`: the account is active (the `MemberLookup
 *    .userIdsForSlugs` rule) and no block stands between the two people;
 *  - `self`: the viewer is never their own candidate;
 *  - `system_account`: `users.is_system` is false;
 *  - `not_connected`: the profile is the far end of an accepted edge;
 *  - `already_member`: no roster row in this community;
 *  - `banned`: no live ban here, nor in the parent for a space;
 *  - `not_parent_member`: for a space, a roster row in the parent;
 *  - `pending_request`: no pending join request here;
 *  - `already_invited`: no LIVE invitation here (`whereInviteIsLive`), so a
 *    dead pending row leaves its holder invitable, as the send treats them.
 *
 * Every predicate is anchored on the viewer's own `connections` edges, so the
 * scan and the folded text match only ever run over that member's connection
 * degree. Two queries per page (rows and count) whatever the page size.
 *
 * Plain functions taking the caller's repositories, the same shape
 * `community-invite-liveness.ts` uses, so no DI registration is needed.
 */

const CANDIDATE_ALIAS = 'other';
const CANDIDATE_INVITE_ALIAS = 'candidate_invite';

export interface InviteCandidateSources {
  profiles: Repository<Profile>;
  invites: Repository<CommunityInvite>;
  blockFilter: BlockFilterService;
}

/** The candidates query for one page, unexecuted. Exported for the spec and
 *  for reading the built SQL back. */
export function buildInviteCandidatesQuery(
  sources: InviteCandidateSources,
  community: Pick<Community, 'id' | 'parentId'>,
  viewerUserId: string,
  searchTerm: string,
): SelectQueryBuilder<Profile> {
  // The far end of each edge, read from the viewer's side. The same rule
  // `ConnectionsService.buildSearchableListQuery` joins its profile on.
  const otherUserIdExpression =
    'CASE WHEN "connection"."requester_id" = :viewerUserId ' +
    'THEN "connection"."addressee_id" ELSE "connection"."requester_id" END';

  const query = sources.profiles
    .createQueryBuilder(CANDIDATE_ALIAS)
    .select([
      `${CANDIDATE_ALIAS}.userId`,
      `${CANDIDATE_ALIAS}.slug`,
      `${CANDIDATE_ALIAS}.firstName`,
      `${CANDIDATE_ALIAS}.lastName`,
      `${CANDIDATE_ALIAS}.pronouns`,
      `${CANDIDATE_ALIAS}.avatarUrl`,
      `${CANDIDATE_ALIAS}.photoVisible`,
    ])
    .setParameter('viewerUserId', viewerUserId)
    .innerJoin(
      Connection,
      'connection',
      `"other"."user_id" = ${otherUserIdExpression}`,
    )
    .innerJoin(
      User,
      'candidate_user',
      '"candidate_user"."id" = "other"."user_id"',
    )
    // not_connected
    .where(
      '("connection"."requester_id" = :viewerUserId ' +
        'OR "connection"."addressee_id" = :viewerUserId)',
    )
    .andWhere('"connection"."status" = :candidateAcceptedStatus', {
      candidateAcceptedStatus: ConnectionStatus.Accepted,
    })
    // self
    .andWhere('"other"."user_id" <> :viewerUserId')
    // unknown_member (an inactive account resolves to nobody)
    .andWhere('"candidate_user"."status" = :candidateActiveUserStatus', {
      candidateActiveUserStatus: UserStatus.Active,
    })
    // system_account
    .andWhere('"candidate_user"."is_system" = false')
    // already_member
    .andWhere(
      `NOT EXISTS (SELECT 1 FROM "community_members" "candidate_roster"
        WHERE "candidate_roster"."community_id" = :candidateCommunityId
          AND "candidate_roster"."user_id" = "other"."user_id")`,
      { candidateCommunityId: community.id },
    )
    // banned: a ban with no `expires_at` is permanent, a timed one stops
    // barring the member the moment it lapses. For a space the parent's ban
    // counts too, exactly as `bannedUserIds` is read twice by the send.
    .andWhere(
      `NOT EXISTS (SELECT 1 FROM "community_bans" "candidate_ban"
        WHERE "candidate_ban"."community_id" IN (:...candidateBanCommunityIds)
          AND "candidate_ban"."user_id" = "other"."user_id"
          AND ("candidate_ban"."expires_at" IS NULL
            OR "candidate_ban"."expires_at" > now()))`,
      {
        candidateBanCommunityIds: community.parentId
          ? [community.id, community.parentId]
          : [community.id],
      },
    )
    // pending_request
    .andWhere(
      `NOT EXISTS (SELECT 1 FROM "community_join_requests" "candidate_request"
        WHERE "candidate_request"."community_id" = :candidateCommunityId
          AND "candidate_request"."user_id" = "other"."user_id"
          AND "candidate_request"."status" = :candidatePendingRequestStatus)`,
      { candidatePendingRequestStatus: JoinRequestStatus.Pending },
    );

  // not_parent_member
  if (community.parentId) {
    query.andWhere(
      `EXISTS (SELECT 1 FROM "community_members" "candidate_parent_roster"
        WHERE "candidate_parent_roster"."community_id" = :candidateParentCommunityId
          AND "candidate_parent_roster"."user_id" = "other"."user_id")`,
      { candidateParentCommunityId: community.parentId },
    );
  }

  // already_invited, read through the one liveness definition. The subquery
  // borrows the invites repository only to build its SQL; its parameters are
  // carried onto the outer query, which is the one that runs.
  const liveInviteQuery = whereInviteIsLive(
    sources.invites
      .createQueryBuilder(CANDIDATE_INVITE_ALIAS)
      .select('1')
      .where(
        `"${CANDIDATE_INVITE_ALIAS}"."community_id" = :candidateCommunityId`,
        { candidateCommunityId: community.id },
      )
      .andWhere(
        `"${CANDIDATE_INVITE_ALIAS}"."invited_user_id" = "other"."user_id"`,
      ),
    CANDIDATE_INVITE_ALIAS,
  );
  query
    .andWhere(`NOT EXISTS (${liveInviteQuery.getQuery()})`)
    .setParameters(liveInviteQuery.getParameters());

  // unknown_member (a block either way reads as nobody, on both surfaces)
  sources.blockFilter.excludeBlocked(query, viewerUserId, '"other"."user_id"');

  if (searchTerm) {
    // One folded `LIKE` over name + handle + headline, the connections list's
    // own search. The term is LIKE-escaped so a `%` is searched for literally.
    query.andWhere(
      `${foldedTextExpression(`(${CONNECTION_SEARCH_HAYSTACK})`)} ` +
        `LIKE ${foldedTextExpression(':searchPattern')} ESCAPE '\\'`,
      { searchPattern: `%${escapeLikeTerm(searchTerm)}%` },
    );
  }

  // Most recently connected first, with a stable tiebreak so two edges
  // accepted in the same instant cannot swap pages.
  return query
    .orderBy('"connection"."responded_at"', 'DESC', 'NULLS LAST')
    .addOrderBy('"connection"."id"', 'ASC');
}

/** One page of invite candidates as `MemberRef`s, with the true filtered
 *  total. `page` is expected to be normalized already. */
export async function listInviteCandidates(
  sources: InviteCandidateSources,
  community: Pick<Community, 'id' | 'parentId'>,
  viewerUserId: string,
  searchTerm: string,
  page: number,
): Promise<Paginated<MemberRef>> {
  // `.offset()`/`.limit()` page this query as written. It joins and orders by
  // a joined column, the exact combination `.skip()`/`.take()` gets wrong.
  const [profiles, total] = await buildInviteCandidatesQuery(
    sources,
    community,
    viewerUserId,
    searchTerm,
  )
    .offset((page - 1) * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .getManyAndCount();

  return {
    items: profiles
      .map((profile) => toMemberRef(profile))
      .filter((memberRef): memberRef is MemberRef => memberRef !== null),
    total,
    page,
    pageSize: PAGE_SIZE,
  };
}
