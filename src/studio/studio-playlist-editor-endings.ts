import { EntityManager } from 'typeorm';

/**
 * Collaborative playlists: every way an editor's seat ends on its own,
 * plus the owner's removal and the editor's leave. Each is ONE statement:
 * a data-modifying CTE `"ended_editor"` moves the live rows (`invited`,
 * `active`) to an ended status and returns `(playlist_id, user_id)`, and the
 * outer `UPDATE` clears `added_by_user_id` for exactly those pairs on those
 * playlists. The tracks they added stay.
 *
 * Plain functions over the caller's `EntityManager`, like
 * `releasePlaylistCreditsOfPersona`, so the subprofiles module calls them
 * inside its own transaction without importing the Studio module.
 *
 * Lock order: these take editor rows, then entry rows. The playlist writes
 * take the playlist row, then the editor row (`FOR SHARE`), then entries,
 * so the two queue in one order.
 */

export type StudioPlaylistEditorEndStatus = 'revoked' | 'left';

const LIVE_STATUS_LIST = `'invited', 'active'`;

/** The shared tail: reads the `"ended_editor"` CTE the statement opens
 *  with. */
export const CLEAR_ENDED_EDITOR_ADDED_BY_SQL = `UPDATE "studio_playlist_tracks" "entry"
   SET "added_by_user_id" = NULL
  FROM "ended_editor"
 WHERE "entry"."playlist_id" = "ended_editor"."playlist_id"
   AND "entry"."added_by_user_id" = "ended_editor"."user_id"`;

/** `$1` the playlist, `$2` the members (uuid[]), `$3` `revoked` or `left`.
 *  The owner removing an editor or cancelling an invite, an editor leaving,
 *  and a credit change ending the editors who no longer fit. */
export const END_EDITORS_ON_PLAYLIST_SQL = `WITH "ended_editor" AS (
  UPDATE "studio_playlist_editors" "editor"
     SET "status" = $3::"studio_playlist_editors_status_enum",
         "ended_at" = now()
   WHERE "editor"."playlist_id" = $1
     AND "editor"."user_id" = ANY($2::uuid[])
     AND "editor"."status" IN (${LIVE_STATUS_LIST})
  RETURNING "editor"."playlist_id", "editor"."user_id"
)
${CLEAR_ENDED_EDITOR_ADDED_BY_SQL}`;

/** `$1` the persona, `$2` the member who left it or was removed. Ends the
 *  member's co-owner seats on playlists credited to the persona, and every
 *  co-owner seat on the playlists that member owns credited to it (their
 *  credit stops standing once the owner leaves the persona). */
export const END_PLAYLIST_EDITING_OF_CO_OWNER_SQL = `WITH "ended_editor" AS (
  UPDATE "studio_playlist_editors" "editor"
     SET "status" = 'revoked',
         "ended_at" = now()
    FROM "studio_playlists" "credited_playlist"
   WHERE "editor"."playlist_id" = "credited_playlist"."id"
     AND "credited_playlist"."is_credited_to_persona"
     AND "credited_playlist"."credit_subprofile_id" = $1
     AND "editor"."source" = 'persona_co_owner'
     AND "editor"."status" IN (${LIVE_STATUS_LIST})
     AND ("editor"."user_id" = $2 OR "credited_playlist"."user_id" = $2)
  RETURNING "editor"."playlist_id", "editor"."user_id"
)
${CLEAR_ENDED_EDITOR_ADDED_BY_SQL}`;

/** `$1` and `$2` two members, either order. Ends every live seat one of
 *  them holds on a playlist the other owns. */
export const END_EDITING_BETWEEN_MEMBERS_SQL = `WITH "ended_editor" AS (
  UPDATE "studio_playlist_editors" "editor"
     SET "status" = 'revoked',
         "ended_at" = now()
    FROM "studio_playlists" "owned_playlist"
   WHERE "editor"."playlist_id" = "owned_playlist"."id"
     AND "editor"."status" IN (${LIVE_STATUS_LIST})
     AND (("owned_playlist"."user_id" = $1 AND "editor"."user_id" = $2)
       OR ("owned_playlist"."user_id" = $2 AND "editor"."user_id" = $1))
  RETURNING "editor"."playlist_id", "editor"."user_id"
)
${CLEAR_ENDED_EDITOR_ADDED_BY_SQL}`;

/** The middle CTE of a persona credit release: reads the
 *  `"released_playlist"` CTE (the playlists whose credit was just released)
 *  and ends their persona co-owner seats. A released playlist reads as the
 *  owner's own private list, which a co-owner source no longer fits. */
export const RELEASED_PLAYLIST_EDITORS_CTE = `"ended_editor" AS (
  UPDATE "studio_playlist_editors" "editor"
     SET "status" = 'revoked',
         "ended_at" = now()
    FROM "released_playlist"
   WHERE "editor"."playlist_id" = "released_playlist"."id"
     AND "editor"."source" = 'persona_co_owner'
     AND "editor"."status" IN (${LIVE_STATUS_LIST})
  RETURNING "editor"."playlist_id", "editor"."user_id"
)`;

export async function endEditorsOnPlaylist(
  manager: EntityManager,
  playlistId: string,
  userIds: string[],
  endedStatus: StudioPlaylistEditorEndStatus,
): Promise<void> {
  if (!userIds.length) {
    return;
  }
  await manager.query(END_EDITORS_ON_PLAYLIST_SQL, [
    playlistId,
    userIds,
    endedStatus,
  ]);
}

/** Called by `SubprofileMembershipService` in the transaction that deletes
 *  the `subprofile_members` row (leave, removal, account erasure handoff). */
export async function endPlaylistEditingOfCoOwner(
  manager: EntityManager,
  subprofileId: string,
  userId: string,
): Promise<void> {
  await manager.query(END_PLAYLIST_EDITING_OF_CO_OWNER_SQL, [
    subprofileId,
    userId,
  ]);
}

/** Called by the `MEMBER_BLOCKED` listener. */
export async function endEditingBetweenMembers(
  manager: EntityManager,
  firstUserId: string,
  secondUserId: string,
): Promise<void> {
  await manager.query(END_EDITING_BETWEEN_MEMBERS_SQL, [
    firstUserId,
    secondUserId,
  ]);
}
