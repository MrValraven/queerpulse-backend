import { EntityManager } from 'typeorm';

/**
 * Studio discovery: what a persona unlink ends. Every persona credit the
 * persona gave (on its own tracks) or received (on anyone's tracks) is
 * deleted, and so is every staff pick of its releases, the way followers
 * and endorsements are deleted (`cutTiesToNamedPersona`). Kept, a credit
 * would point the named persona's collaborators at the pseudonymous one,
 * and a pick would keep the named persona's shelf spot and note.
 *
 * Runs inside the unlink transaction, after the persona row has moved to
 * its fresh id (the subprofile foreign keys carried the credits along) and
 * before its releases and tracks get fresh ids. A plain function over the
 * caller's `EntityManager`, like `releasePlaylistCreditsOfPersona`, so the
 * subprofiles module calls it without importing the Studio module.
 */
export async function forgetDiscoveryTiesOfPersona(
  manager: EntityManager,
  subprofileId: string,
): Promise<void> {
  await manager.query(
    `DELETE FROM "studio_persona_credits"
      WHERE "subprofile_id" = $1
         OR "requested_by_subprofile_id" = $1
         OR "track_id" IN (
           SELECT "track"."id" FROM "studio_tracks" "track"
            INNER JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
            WHERE "release"."subprofile_id" = $1
         )`,
    [subprofileId],
  );
  await manager.query(
    `DELETE FROM "studio_curated_picks"
      WHERE "release_id" IN (
        SELECT "id" FROM "studio_releases" WHERE "subprofile_id" = $1
      )`,
    [subprofileId],
  );
}
