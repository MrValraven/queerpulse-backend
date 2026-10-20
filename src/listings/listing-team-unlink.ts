import { EntityManager } from 'typeorm';

/**
 * Meet the team: what a persona unlink ends. Every team link the persona
 * holds (pending, accepted or declined, on any business listing) is deleted,
 * the way followers and endorsements are deleted (`cutTiesToNamedPersona`).
 * A kept link would show the pseudonymous persona at the named persona's
 * workplace with the same role.
 *
 * Runs inside the unlink transaction, after the persona row has moved to its
 * fresh id (the subprofile foreign key carried the rows along). A plain
 * function over the caller's `EntityManager`, like
 * `forgetDiscoveryTiesOfPersona`, so the subprofiles module calls it without
 * importing the listings module.
 */
export async function forgetTeamLinksOfPersona(
  manager: EntityManager,
  subprofileId: string,
): Promise<void> {
  await manager.query(
    `DELETE FROM "listing_team_members" WHERE "subprofile_id" = $1`,
    [subprofileId],
  );
}
