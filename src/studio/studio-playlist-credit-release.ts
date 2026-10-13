import { EntityManager } from 'typeorm';
import { SUBPROFILE_MODERATION_SUBJECT_TYPE } from '../subprofiles/subprofile-takedown';
import { listenablePersonaSql } from './studio-visibility';

/**
 * Studio v2: what a playlist becomes when the persona it is credited to
 * stops being listenable (deleted, unlinked, unpublished, made network or
 * private, removed, or taken down). It turns private and loses the credit,
 * so it never falls back to its owner's name for anyone. Each persona path
 * calls one of the functions below inside its own transaction, so the
 * release commits or rolls back with the persona change. Readers apply the
 * same rule on their own (`personaCreditActiveSql`), so a path that misses a
 * hook still shows nothing.
 *
 * Plain functions over the caller's `EntityManager`, the way
 * `issueFreshPersonaId` is, so the subprofiles and content moderation
 * modules call them without importing the Studio module.
 */
export const PLAYLIST_CREDIT_RELEASE_ASSIGNMENTS = `"visibility" = 'private',
            "credit_subprofile_id" = NULL,
            "is_credited_to_persona" = false,
            "updated_at" = now()`;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every playlist credited to this persona, whatever its state now. For the
 *  paths that end the persona's current identity: delete and unlink. */
export async function releasePlaylistCreditsOfPersona(
  manager: EntityManager,
  subprofileId: string,
): Promise<void> {
  await manager.query(
    `UPDATE "studio_playlists"
        SET ${PLAYLIST_CREDIT_RELEASE_ASSIGNMENTS}
      WHERE "credit_subprofile_id" = $1`,
    [subprofileId],
  );
}

/** The playlists credited to this persona, only when the persona as it
 *  stands inside the caller's transaction fails `listenablePersonaSql`. Runs
 *  after every persona save, so a save that keeps the persona live changes
 *  nothing. */
export async function releasePlaylistCreditsIfPersonaUnlistenable(
  manager: EntityManager,
  subprofileId: string,
): Promise<void> {
  await manager.query(
    `UPDATE "studio_playlists"
        SET ${PLAYLIST_CREDIT_RELEASE_ASSIGNMENTS}
      WHERE "credit_subprofile_id" = $1
        AND NOT EXISTS (
          SELECT 1 FROM "subprofiles" "credit_persona"
           WHERE "credit_persona"."id" = $1
             AND ${listenablePersonaSql('credit_persona')}
        )`,
    [subprofileId],
  );
}

/** A moderator takedown (hide or remove) of a persona. Any other subject,
 *  and a legacy persona subject id that is no uuid, leaves playlists alone. */
export async function releasePlaylistCreditsOnTakedown(
  manager: EntityManager,
  subjectType: string,
  subjectId: string,
): Promise<void> {
  if (
    subjectType !== SUBPROFILE_MODERATION_SUBJECT_TYPE ||
    !UUID_PATTERN.test(subjectId)
  ) {
    return;
  }
  await releasePlaylistCreditsOfPersona(manager, subjectId.toLowerCase());
}
