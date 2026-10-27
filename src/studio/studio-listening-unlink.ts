import { EntityManager } from 'typeorm';

/**
 * Studio listening: what a persona unlink ends. The daily play totals and
 * the listens on the persona's tracks are deleted, and so is every supporter
 * opt-in that names the persona, as the supporter or as the identity shown.
 * Carried over, any of these rows would tie the pseudonymous persona to its
 * named past, and deleting them before the re-key leaves the track keys
 * nothing to carry.
 *
 * Runs inside the unlink transaction, after the persona row has moved to its
 * fresh id and before its releases and tracks get fresh ids. A plain function
 * over the caller's `EntityManager`, like `forgetDiscoveryTiesOfPersona`, so
 * the subprofiles module calls it without importing the Studio module.
 */
export async function forgetListeningOfPersona(
  manager: EntityManager,
  subprofileId: string,
): Promise<void> {
  await manager.query(
    `DELETE FROM "studio_track_play_daily"
      WHERE "track_id" IN (
        SELECT "track"."id" FROM "studio_tracks" "track"
         INNER JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
         WHERE "release"."subprofile_id" = $1
      )`,
    [subprofileId],
  );
  await manager.query(
    `DELETE FROM "studio_listens"
      WHERE "track_id" IN (
        SELECT "track"."id" FROM "studio_tracks" "track"
         INNER JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
         WHERE "release"."subprofile_id" = $1
      )`,
    [subprofileId],
  );
  await manager.query(
    `DELETE FROM "studio_supporters"
      WHERE "subprofile_id" = $1
         OR "shown_as_subprofile_id" = $1`,
    [subprofileId],
  );
}
