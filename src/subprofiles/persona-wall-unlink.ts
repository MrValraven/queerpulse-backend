import { EntityManager } from 'typeorm';

/**
 * Persona wall: the statement that drops a persona's wall pick on unlink.
 * Keyed by the persona's (fresh) id, which the pick's foreign key carried
 * along with the row.
 */
export const FORGET_PERSONA_WALL_PICK_SQL = `DELETE FROM "persona_wall_picks" WHERE "subprofile_id" = $1`;

/**
 * Persona wall: what a persona unlink ends. The persona's pick on the
 * directory wall is deleted, the way followers, endorsements and team links
 * are deleted (`cutTiesToNamedPersona`). A kept pick would hold the
 * pseudonymous persona in the wall slot the named persona had, so the tile
 * members saw under the named persona would turn into it in the same place.
 *
 * The row is deleted without closing the position gap it leaves, which the
 * admin view and the next reorder absorb, so the unlink takes no lock on the
 * wall table.
 *
 * Runs inside the unlink transaction, after the persona row has moved to its
 * fresh id (the subprofile foreign key carried the pick along). A plain
 * function over the caller's `EntityManager`, like `forgetTeamLinksOfPersona`,
 * so the subprofiles module calls it with no repository of its own.
 */
export async function forgetWallPickOfPersona(
  manager: EntityManager,
  subprofileId: string,
): Promise<void> {
  await manager.query(FORGET_PERSONA_WALL_PICK_SQL, [subprofileId]);
}
