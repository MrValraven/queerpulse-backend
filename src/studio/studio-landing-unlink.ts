import { EntityManager } from 'typeorm';
import { invalidateStudioLandingMemo } from './studio-landing-memo';

/**
 * Studio landing v2: what a persona unlink ends on the public Studio page.
 * The persona's artist card, its founding place and every preview of a track
 * on its own releases are deleted. The consent and the founding place were
 * given under the named persona, so the pseudonymous one starts clean, as
 * staff picks do. Previews on tracks where the persona is only credited stay.
 *
 * Runs inside the unlink transaction, after the persona row has moved to its
 * fresh id and before its releases and tracks get fresh ids. A plain function
 * over the caller's `EntityManager`, like `forgetListeningOfPersona`, so the
 * subprofiles module calls it without importing the Studio module. It bumps
 * the landing memo generation (`studio-landing-memo.ts`, which imports
 * nothing) so a page built before the unlink never serves as current; a
 * rebuild between the bump and the commit may hold the old rows for up to
 * 60 seconds.
 */
export async function forgetLandingTiesOfPersona(
  manager: EntityManager,
  subprofileId: string,
): Promise<void> {
  await manager.query(
    `DELETE FROM "studio_landing_artist_cards" WHERE "subprofile_id" = $1`,
    [subprofileId],
  );
  await manager.query(
    `DELETE FROM "studio_founding_artists" WHERE "subprofile_id" = $1`,
    [subprofileId],
  );
  await manager.query(
    `DELETE FROM "studio_landing_previews"
      WHERE "track_id" IN (
        SELECT "track"."id" FROM "studio_tracks" "track"
         INNER JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
         WHERE "release"."subprofile_id" = $1
      )`,
    [subprofileId],
  );
  invalidateStudioLandingMemo();
}
