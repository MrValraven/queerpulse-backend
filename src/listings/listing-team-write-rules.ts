import { EntityManager, In } from 'typeorm';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import { ListingCoManagerStatus } from './entities/listing-co-manager.entity';
import {
  LIVE_LISTING_TEAM_STATUSES,
  ListingTeamInitiator,
  ListingTeamMember,
  ListingTeamMemberStatus,
} from './entities/listing-team-member.entity';
import {
  LISTING_TEAM_LIMITS,
  listingTeamError,
} from './listing-team.constants';
import {
  eligibleMemberSql,
  eligiblePersonaSql,
  publiclyVisibleListingSql,
} from './listing-team-visibility';

/**
 * The write rules every "Meet the team" mutation shares. Each helper takes the
 * caller's transactional `EntityManager` first, so the locks it takes and the
 * rows it reads belong to that one transaction.
 *
 * Lock order in every team write: the `listings` row, then the
 * `listing_team_members` row, then the `subprofiles` row, each `FOR UPDATE`.
 * Listing caps and positions are counted only after the listing row is
 * locked; persona caps only after the persona row is locked.
 *
 * A member row has no persona row to lock. Its order is the listing row, the
 * `listing_team_members` row, then `lockMemberCap`'s advisory lock keyed on
 * the member; member caps are counted only after that lock is held.
 */

/** Locks one `listings` row for the rest of the transaction. */
export async function lockListingRow(
  manager: EntityManager,
  listingId: string,
): Promise<void> {
  await manager.query(
    `SELECT "id" FROM "listings" WHERE "id" = $1 FOR UPDATE`,
    [listingId],
  );
}

/**
 * Locks one `subprofiles` row for the rest of the transaction. Answers true
 * when a row was locked, so a persona gone since the route began reads as
 * not found.
 */
export async function lockPersonaRow(
  manager: EntityManager,
  subprofileId: string,
): Promise<boolean> {
  const rows = await manager.query<{ id: string }[]>(
    `SELECT "id" FROM "subprofiles" WHERE "id" = $1 FOR UPDATE`,
    [subprofileId],
  );
  return rows.length > 0;
}

/** Locks and answers one team row, or null when it does not exist. */
export function lockTeamRow(
  manager: EntityManager,
  memberId: string,
): Promise<ListingTeamMember | null> {
  return manager.findOne(ListingTeamMember, {
    where: { id: memberId },
    lock: { mode: 'pessimistic_write' },
  });
}

/** What a team write needs to know about the listing side. */
export interface TeamListingFacts {
  id: string;
  ref: string;
  slug: string;
  name: string;
  ownerUserId: string | null;
  isPubliclyVisible: boolean;
}

interface TeamListingFactsRow {
  id: string;
  ref: string;
  slug: string;
  name: string;
  owner_id: string | null;
  is_publicly_visible: boolean;
}

export async function readListingFacts(
  manager: EntityManager,
  listingId: string,
): Promise<TeamListingFacts | null> {
  const rows = await manager.query<TeamListingFactsRow[]>(
    `SELECT "listing"."id", "listing"."ref", "listing"."slug", "listing"."name", "listing"."owner_id",
            (${publiclyVisibleListingSql('listing')}) AS "is_publicly_visible"
       FROM "listings" "listing"
      WHERE "listing"."id" = $1`,
    [listingId],
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    ref: row.ref,
    slug: row.slug,
    name: row.name,
    ownerUserId: row.owner_id,
    isPubliclyVisible: row.is_publicly_visible === true,
  };
}

/** What a team write needs to know about the persona side. */
export interface TeamPersonaFacts {
  id: string;
  ownerUserId: string;
  isEligible: boolean;
}

interface TeamPersonaFactsRow {
  id: string;
  user_id: string;
  is_eligible: boolean;
}

export async function readPersonaFacts(
  manager: EntityManager,
  subprofileId: string,
): Promise<TeamPersonaFacts | null> {
  const rows = await manager.query<TeamPersonaFactsRow[]>(
    `SELECT "persona"."id", "persona"."user_id",
            (${eligiblePersonaSql('persona')}) AS "is_eligible"
       FROM "subprofiles" "persona"
      WHERE "persona"."id" = $1`,
    [subprofileId],
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    ownerUserId: row.user_id,
    isEligible: row.is_eligible === true,
  };
}

/** What a team write needs to know about the member side. */
export interface TeamMemberFacts {
  userId: string;
  isEligible: boolean;
}

interface TeamMemberFactsRow {
  user_id: string;
  is_eligible: boolean;
}

/**
 * Null when the member has no profile or no account. Eligibility is the
 * `eligibleMemberSql` rule: an active account, an open profile, not self-hidden
 * and free of a moderator takedown.
 */
export async function readMemberFacts(
  manager: EntityManager,
  memberUserId: string,
): Promise<TeamMemberFacts | null> {
  const rows = await manager.query<TeamMemberFactsRow[]>(
    `SELECT "member_user"."id" AS "user_id",
            (${eligibleMemberSql('member_profile', 'member_user')}) AS "is_eligible"
       FROM "users" "member_user"
       JOIN "profiles" "member_profile" ON "member_profile"."user_id" = "member_user"."id"
      WHERE "member_user"."id" = $1`,
    [memberUserId],
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  return { userId: row.user_id, isEligible: row.is_eligible === true };
}

/** True when the two members hold an accepted connection, in either direction. */
export async function isAcceptedConnection(
  manager: EntityManager,
  actingUserId: string,
  memberUserId: string,
): Promise<boolean> {
  const rows = await manager.query<{ is_connected: boolean }[]>(
    `SELECT EXISTS (
       SELECT 1 FROM "connections" "connection"
        WHERE "connection"."status" = 'accepted'
          AND (("connection"."requester_id" = $1 AND "connection"."addressee_id" = $2)
            OR ("connection"."requester_id" = $2 AND "connection"."addressee_id" = $1))
     ) AS "is_connected"`,
    [actingUserId, memberUserId],
  );
  return rows[0]?.is_connected === true;
}

/**
 * Serialises every write that counts one member's accepted teams, so two
 * listings cannot both take the member past the cap. Taken after the listing
 * row and the team row, and held until the transaction ends.
 */
export async function lockMemberCap(
  manager: EntityManager,
  memberUserId: string,
): Promise<void> {
  await manager.query(
    `SELECT pg_advisory_xact_lock(hashtext('listing_team_member:' || $1::text))`,
    [memberUserId],
  );
}

/**
 * True when either member has blocked the other. A listing with no owner and
 * a member compared with themself have no block to find.
 */
export async function hasBlockEitherWay(
  manager: EntityManager,
  firstUserId: string,
  secondUserId: string | null,
): Promise<boolean> {
  if (secondUserId === null || firstUserId === secondUserId) {
    return false;
  }
  const rows = await manager.query<{ is_blocked: boolean }[]>(
    `SELECT EXISTS (
       SELECT 1 FROM "blocks" "block"
        WHERE ("block"."blocker_id" = $1 AND "block"."blocked_id" = $2)
           OR ("block"."blocker_id" = $2 AND "block"."blocked_id" = $1)
     ) AS "is_blocked"`,
    [firstUserId, secondUserId],
  );
  return rows[0]?.is_blocked === true;
}

/** True when the member holds a `subprofile_members` row for the persona. */
export async function isPersonaMember(
  manager: EntityManager,
  subprofileId: string,
  userId: string,
): Promise<boolean> {
  const count = await manager.count(SubprofileMember, {
    where: { subprofileId, userId },
  });
  return count > 0;
}

/** True for the listing's owner and for an active co-manager. */
export async function managesListing(
  manager: EntityManager,
  listingId: string,
  userId: string,
): Promise<boolean> {
  const rows = await manager.query<{ is_manager: boolean }[]>(
    `SELECT (
       EXISTS (
         SELECT 1 FROM "listings" "listing"
          WHERE "listing"."id" = $1 AND "listing"."owner_id" = $2
       )
       OR EXISTS (
         SELECT 1 FROM "listing_co_managers" "co_manager"
          WHERE "co_manager"."listing_id" = $1
            AND "co_manager"."user_id" = $2
            AND "co_manager"."status" = '${ListingCoManagerStatus.Active}'
       )
     ) AS "is_manager"`,
    [listingId, userId],
  );
  return rows[0]?.is_manager === true;
}

/**
 * Refuses a new invite or request for a pair that is already linked, already
 * waiting in either direction, or inside the cooldown of a decline this same
 * side received.
 */
export async function assertPairOpen(
  manager: EntityManager,
  listingId: string,
  subprofileId: string,
  initiatedBy: ListingTeamInitiator,
): Promise<void> {
  const liveRow = await manager.findOne(ListingTeamMember, {
    where: {
      listingId,
      subprofileId,
      status: In([...LIVE_LISTING_TEAM_STATUSES]),
    },
  });
  if (liveRow?.status === ListingTeamMemberStatus.Accepted) {
    throw listingTeamError('listing_team_already_accepted');
  }
  if (liveRow?.status === ListingTeamMemberStatus.Pending) {
    throw listingTeamError('listing_team_already_pending', {
      initiatedBy: liveRow.initiatedBy,
    });
  }
  const cooldownRows = await manager.query<{ retry_at: Date | string }[]>(
    `SELECT "answered_at" + make_interval(days => $4) AS "retry_at"
       FROM "listing_team_members"
      WHERE "listing_id" = $1 AND "subprofile_id" = $2 AND "initiated_by" = $3
        AND "status" = '${ListingTeamMemberStatus.Declined}'
        AND "answered_at" + make_interval(days => $4) > now()
      ORDER BY "answered_at" DESC
      LIMIT 1`,
    [listingId, subprofileId, initiatedBy, LISTING_TEAM_LIMITS.cooldownDays],
  );
  const cooldownRow = cooldownRows[0];
  if (cooldownRow) {
    throw listingTeamError('listing_team_cooldown', {
      retryAt: new Date(cooldownRow.retry_at).toISOString(),
    });
  }
}

/**
 * Refuses a new member invite for a member who is already on the listing's
 * team, already invited, or inside the cooldown of a decline the member sent
 * this listing. Member rows are always started by the listing.
 */
export async function assertMemberPairOpen(
  manager: EntityManager,
  listingId: string,
  memberUserId: string,
): Promise<void> {
  const liveRow = await manager.findOne(ListingTeamMember, {
    where: {
      listingId,
      userId: memberUserId,
      status: In([...LIVE_LISTING_TEAM_STATUSES]),
    },
  });
  if (liveRow?.status === ListingTeamMemberStatus.Accepted) {
    throw listingTeamError('listing_team_already_accepted');
  }
  if (liveRow?.status === ListingTeamMemberStatus.Pending) {
    throw listingTeamError('listing_team_already_pending', {
      initiatedBy: liveRow.initiatedBy,
    });
  }
  const cooldownRows = await manager.query<{ retry_at: Date | string }[]>(
    `SELECT "answered_at" + make_interval(days => $4) AS "retry_at"
       FROM "listing_team_members"
      WHERE "listing_id" = $1 AND "user_id" = $2 AND "initiated_by" = $3
        AND "status" = '${ListingTeamMemberStatus.Declined}'
        AND "answered_at" + make_interval(days => $4) > now()
      ORDER BY "answered_at" DESC
      LIMIT 1`,
    [
      listingId,
      memberUserId,
      ListingTeamInitiator.Listing,
      LISTING_TEAM_LIMITS.cooldownDays,
    ],
  );
  const cooldownRow = cooldownRows[0];
  if (cooldownRow) {
    throw listingTeamError('listing_team_cooldown', {
      retryAt: new Date(cooldownRow.retry_at).toISOString(),
    });
  }
}

/** Room for one more accepted row on the listing (both kinds counted) and one more team on the member. */
export async function assertMemberAcceptedRoom(
  manager: EntityManager,
  listingId: string,
  memberUserId: string,
): Promise<void> {
  const acceptedOnListing = await manager.count(ListingTeamMember, {
    where: { listingId, status: ListingTeamMemberStatus.Accepted },
  });
  if (acceptedOnListing >= LISTING_TEAM_LIMITS.acceptedPerListing) {
    throw listingTeamError('listing_team_full');
  }
  const acceptedOfMember = await manager.count(ListingTeamMember, {
    where: { userId: memberUserId, status: ListingTeamMemberStatus.Accepted },
  });
  if (acceptedOfMember >= LISTING_TEAM_LIMITS.acceptedPerMember) {
    throw listingTeamError('listing_team_member_full');
  }
}

/** Room for one more accepted member on the listing and one more listing on the persona. */
export async function assertAcceptedRoom(
  manager: EntityManager,
  listingId: string,
  subprofileId: string,
): Promise<void> {
  const acceptedOnListing = await manager.count(ListingTeamMember, {
    where: { listingId, status: ListingTeamMemberStatus.Accepted },
  });
  if (acceptedOnListing >= LISTING_TEAM_LIMITS.acceptedPerListing) {
    throw listingTeamError('listing_team_full');
  }
  const acceptedOfPersona = await manager.count(ListingTeamMember, {
    where: { subprofileId, status: ListingTeamMemberStatus.Accepted },
  });
  if (acceptedOfPersona >= LISTING_TEAM_LIMITS.acceptedPerPersona) {
    throw listingTeamError('listing_team_persona_full');
  }
}

/** Room for one more pending row on the listing, invites and requests counted together. */
export async function assertInviteRoom(
  manager: EntityManager,
  listingId: string,
): Promise<void> {
  const pendingOnListing = await manager.count(ListingTeamMember, {
    where: { listingId, status: ListingTeamMemberStatus.Pending },
  });
  if (pendingOnListing >= LISTING_TEAM_LIMITS.pendingPerListing) {
    throw listingTeamError('listing_team_pending_full');
  }
}

/** The listing's pending room, then room for one more request from the persona. */
export async function assertRequestRoom(
  manager: EntityManager,
  listingId: string,
  subprofileId: string,
): Promise<void> {
  await assertInviteRoom(manager, listingId);
  const pendingRequestsOfPersona = await manager.count(ListingTeamMember, {
    where: {
      subprofileId,
      status: ListingTeamMemberStatus.Pending,
      initiatedBy: ListingTeamInitiator.Persona,
    },
  });
  if (
    pendingRequestsOfPersona >= LISTING_TEAM_LIMITS.pendingRequestsPerPersona
  ) {
    throw listingTeamError('listing_team_persona_requests_full');
  }
}

/** The position a newly accepted member takes: last on the team. */
export async function nextTeamPosition(
  manager: EntityManager,
  listingId: string,
): Promise<number> {
  const rows = await manager.query<{ next_position: number | string }[]>(
    `SELECT COALESCE(MAX("position"), 0) + 1 AS "next_position"
       FROM "listing_team_members"
      WHERE "listing_id" = $1 AND "status" = '${ListingTeamMemberStatus.Accepted}'`,
    [listingId],
  );
  return Number(rows[0]?.next_position ?? 1);
}

/** The values of a new live (pending or accepted) team row. */
export interface NewTeamRowValues {
  listingId: string;
  subprofileId: string;
  initiatedBy: ListingTeamInitiator;
  requestedByUserId: string;
  roleLabel: string | null;
  status: ListingTeamMemberStatus.Pending | ListingTeamMemberStatus.Accepted;
  position: number | null;
  answeredAt: Date | null;
}

/**
 * Inserts a live row with the partial unique index as the conflict target, so
 * a lost race comes back as no row and leaves the transaction usable. A miss
 * answers the pair's current refusal through `assertPairOpen`.
 */
export async function insertLiveTeamRow(
  manager: EntityManager,
  values: NewTeamRowValues,
): Promise<ListingTeamMember> {
  const insertedId = await tryInsertLiveTeamRow(manager, values);
  if (insertedId !== null) {
    return manager.findOneOrFail(ListingTeamMember, {
      where: { id: insertedId },
    });
  }
  await assertPairOpen(
    manager,
    values.listingId,
    values.subprofileId,
    values.initiatedBy,
  );
  // The conflicting row was answered between the insert and the re-read, so
  // the pair is open again: one more try settles it.
  const retriedId = await tryInsertLiveTeamRow(manager, values);
  if (retriedId !== null) {
    return manager.findOneOrFail(ListingTeamMember, {
      where: { id: retriedId },
    });
  }
  await assertPairOpen(
    manager,
    values.listingId,
    values.subprofileId,
    values.initiatedBy,
  );
  throw listingTeamError('listing_team_already_pending', {
    initiatedBy: values.initiatedBy,
  });
}

async function tryInsertLiveTeamRow(
  manager: EntityManager,
  values: NewTeamRowValues,
): Promise<string | null> {
  const rows = await manager.query<{ id: string }[]>(
    `WITH "inserted" AS (
       INSERT INTO "listing_team_members"
              ("listing_id", "subprofile_id", "initiated_by", "requested_by_user_id", "role_label", "status", "position", "answered_at")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT ("listing_id", "subprofile_id") WHERE "status" IN ('pending', 'accepted') DO NOTHING
       RETURNING "id"
     )
     SELECT "id" FROM "inserted"`,
    [
      values.listingId,
      values.subprofileId,
      values.initiatedBy,
      values.requestedByUserId,
      values.roleLabel,
      values.status,
      values.position,
      values.answeredAt,
    ],
  );
  return rows[0]?.id ?? null;
}

/** The values of a new live member row. The listing started it, so `initiatedBy` is fixed. */
export interface NewMemberTeamRowValues {
  listingId: string;
  userId: string;
  requestedByUserId: string;
  roleLabel: string | null;
  status: ListingTeamMemberStatus.Pending | ListingTeamMemberStatus.Accepted;
  answeredAt: Date | null;
}

/**
 * Inserts a live member row with the member partial unique index as the
 * conflict target, so a lost race comes back as no row and leaves the
 * transaction usable. A miss answers the pair's current refusal through
 * `assertMemberPairOpen`. A pending row has no position; an accepted row goes
 * last on the team, counted across personas and members together.
 */
export async function insertLiveMemberTeamRow(
  manager: EntityManager,
  values: NewMemberTeamRowValues,
): Promise<ListingTeamMember> {
  const position =
    values.status === ListingTeamMemberStatus.Accepted
      ? await nextTeamPosition(manager, values.listingId)
      : null;
  const insertedId = await tryInsertLiveMemberTeamRow(
    manager,
    values,
    position,
  );
  if (insertedId !== null) {
    return manager.findOneOrFail(ListingTeamMember, {
      where: { id: insertedId },
    });
  }
  await assertMemberPairOpen(manager, values.listingId, values.userId);
  // The conflicting row was answered between the insert and the re-read, so
  // the pair is open again: one more try settles it.
  const retriedId = await tryInsertLiveMemberTeamRow(manager, values, position);
  if (retriedId !== null) {
    return manager.findOneOrFail(ListingTeamMember, {
      where: { id: retriedId },
    });
  }
  await assertMemberPairOpen(manager, values.listingId, values.userId);
  throw listingTeamError('listing_team_already_pending', {
    initiatedBy: ListingTeamInitiator.Listing,
  });
}

async function tryInsertLiveMemberTeamRow(
  manager: EntityManager,
  values: NewMemberTeamRowValues,
  position: number | null,
): Promise<string | null> {
  const rows = await manager.query<{ id: string }[]>(
    `WITH "inserted" AS (
       INSERT INTO "listing_team_members"
              ("listing_id", "user_id", "initiated_by", "requested_by_user_id", "role_label", "status", "position", "answered_at")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT ("listing_id", "user_id") WHERE "status" IN ('pending', 'accepted') DO NOTHING
       RETURNING "id"
     )
     SELECT "id" FROM "inserted"`,
    [
      values.listingId,
      values.userId,
      ListingTeamInitiator.Listing,
      values.requestedByUserId,
      values.roleLabel,
      values.status,
      position,
      values.answeredAt,
    ],
  );
  return rows[0]?.id ?? null;
}
