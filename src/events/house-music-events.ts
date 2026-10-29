import type { EntityManager } from 'typeorm';
import { OFFICIAL_SENDER_GOOGLE_ID } from '../official-messages/official-messages.constants';
import type { StaffRoleId } from '../users/staff-roles.registry';

/**
 * House rules for events QueerPulse hosts in Music. Pure helpers with no Nest
 * dependency injection, so the admin module, the member co-host path and the
 * staff-role grant can all share them inside their own transactions.
 */

/** The staff grant that runs QueerPulse music events. */
export const MUSIC_MANAGER_PRODUCER_ROLE =
  'music_manager_producer' satisfies StaffRoleId;

/**
 * The house account's id as a scalar subquery. The house is the platform
 * account official conversations send from, keyed on its Google id.
 */
export const HOUSE_ACCOUNT_ID_SQL = `(SELECT "house"."id" FROM "users" "house" WHERE "house"."google_id" = '${OFFICIAL_SENDER_GOOGLE_ID}')`;

const COHOST_SEAT_LOCK_PREFIX = 'music_event_cohost:';

/** Whether `userId` is the house account. A null id never is. */
export async function isHouseAccountId(
  manager: EntityManager,
  userId: string | null,
): Promise<boolean> {
  if (userId === null) return false;
  const rows: { is_house: boolean }[] = await manager.query(
    `SELECT COALESCE($1::uuid = ${HOUSE_ACCOUNT_ID_SQL}, false) AS "is_house"`,
    [userId],
  );
  return rows[0]?.is_house === true;
}

/**
 * Serialises every write that seats a member as co-host of a house Music
 * event, or removes those seats, for one member. The lock is held until the
 * surrounding transaction ends, so a grant and a co-host add for the same
 * member never interleave.
 */
export async function lockCohostSeatsForMember(
  manager: EntityManager,
  memberUserId: string,
): Promise<void> {
  await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [
    `${COHOST_SEAT_LOCK_PREFIX}${memberUserId}`,
  ]);
}

export type CohostSeatRefusalCode =
  'music_event_cohost_holds_grant' | 'music_event_cohost_is_staff_tier';

/**
 * Why a member cannot co-host a house Music event, or null when they can.
 * Holding the grant is checked first, so a moderator who also holds it hears
 * about the grant.
 */
export async function cohostSeatRefusalFor(
  manager: EntityManager,
  memberUserId: string,
): Promise<CohostSeatRefusalCode | null> {
  const rows: { refusal: CohostSeatRefusalCode | null }[] = await manager.query(
    `SELECT CASE
         WHEN EXISTS (
           SELECT 1 FROM "user_staff_roles" "staff_role"
           WHERE "staff_role"."user_id" = "member"."id" AND "staff_role"."role" = $2::text
         ) THEN 'music_event_cohost_holds_grant'
         WHEN "member"."role"::text IN ('moderator', 'admin') THEN 'music_event_cohost_is_staff_tier'
         ELSE NULL
       END AS "refusal"
       FROM "users" "member"
       WHERE "member"."id" = $1::uuid`,
    [memberUserId, MUSIC_MANAGER_PRODUCER_ROLE],
  );
  return rows[0]?.refusal ?? null;
}

export interface RemovedHouseMusicCohostSeat {
  eventId: string;
  eventSlug: string;
  eventTitle: string;
}

/**
 * Removes every co-host seat `$1` holds on a house Music event and returns the
 * events those seats were on. Wrapped in WITH so `manager.query` resolves to
 * rows.
 */
export const REMOVE_HOUSE_MUSIC_COHOST_SEATS_SQL = `WITH "removed" AS (DELETE FROM "event_cohosts" "cohost" USING "events" "event" WHERE "cohost"."event_id" = "event"."id" AND "cohost"."user_id" = $1::uuid AND "event"."host_id" = ${HOUSE_ACCOUNT_ID_SQL} AND "event"."gathering_family"::text = 'music' RETURNING "cohost"."event_id") SELECT "event"."id" AS "event_id", "event"."slug" AS "event_slug", "event"."title" AS "event_title" FROM "removed" JOIN "events" "event" ON "event"."id" = "removed"."event_id" ORDER BY "event"."slug", "event"."id"`;

export async function removeHouseMusicCohostSeats(
  manager: EntityManager,
  memberUserId: string,
): Promise<RemovedHouseMusicCohostSeat[]> {
  const rows: { event_id: string; event_slug: string; event_title: string }[] =
    await manager.query(REMOVE_HOUSE_MUSIC_COHOST_SEATS_SQL, [memberUserId]);
  return rows.map((row) => ({
    eventId: row.event_id,
    eventSlug: row.event_slug,
    eventTitle: row.event_title,
  }));
}
