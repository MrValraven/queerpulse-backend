import { HttpException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { StudioPlaylist } from './entities/studio-playlist.entity';
import {
  creditStandsSql,
  playlistOwnerIsActiveSql,
} from './studio-playlist-visibility';
import { studioError } from './studio.constants';

/**
 * Collaborative playlists: the one place a playlist write decides who may
 * make it. Replaces `StudioPlaylistWritesService.lockOwnedPlaylist`.
 *
 * `required: 'owner'` admits the owner. `required: 'editor'` admits the
 * owner and an `active` editor whose row is read `FOR SHARE` (so an ending
 * waits for the write to commit) and who is not blocked either way with the
 * owner (so a block whose listener has not run yet already refuses). Anyone
 * else gets `StudioPlaylistRoleRefusal`, which the service maps with
 * `playlistRoleRefusal` once the transaction has rolled back.
 */

export type StudioPlaylistWriteRole = 'owner' | 'editor';

/** `$1` the playlist, `$2` the caller, `$3` the owner. A persona-credited
 *  playlist whose credit stopped standing, or whose owner's account is not
 *  active, holds no editor role. */
export const LOCK_ACTIVE_EDITOR_ROW_SQL = `SELECT "editor"."id" AS "id"
  FROM "studio_playlist_editors" "editor"
 INNER JOIN "studio_playlists" "playlist" ON "playlist"."id" = "editor"."playlist_id"
 WHERE "editor"."playlist_id" = $1
   AND "editor"."user_id" = $2
   AND "editor"."status" = 'active'
   AND ${creditStandsSql('playlist')}
   AND ${playlistOwnerIsActiveSql('playlist')}
   AND NOT EXISTS (
     SELECT 1 FROM "blocks" "editor_block"
      WHERE ("editor_block"."blocker_id" = $2 AND "editor_block"."blocked_id" = $3)
         OR ("editor_block"."blocker_id" = $3 AND "editor_block"."blocked_id" = $2)
   )
   FOR SHARE OF "editor"`;

/** `$1` the playlist. One row whose `is_standing` says whether its credit
 *  stands (a member credit always does); no row for a missing playlist. */
export const PLAYLIST_CREDIT_STANDS_SQL = `SELECT ${creditStandsSql('playlist')} AS "is_standing" FROM "studio_playlists" "playlist" WHERE "playlist"."id" = $1`;

/** Whether the playlist's credit stands right now. A missing playlist
 *  reads false. */
export async function isPlaylistCreditStanding(
  manager: EntityManager,
  playlistId: string,
): Promise<boolean> {
  const rows: { is_standing: boolean }[] = await manager.query(
    PLAYLIST_CREDIT_STANDS_SQL,
    [playlistId],
  );
  return rows[0]?.is_standing === true;
}

export class StudioPlaylistRoleRefusal extends Error {
  constructor() {
    super('The caller lacks the playlist role this write needs');
    this.name = 'StudioPlaylistRoleRefusal';
  }
}

export interface LockedPlaylist {
  playlist: StudioPlaylist;
  role: StudioPlaylistWriteRole;
}

/** The playlist row under `pessimistic_write`, or 404. */
export async function lockPlaylistRow(
  manager: EntityManager,
  playlistId: string,
): Promise<StudioPlaylist> {
  const playlist = await manager.findOne(StudioPlaylist, {
    where: { id: playlistId },
    lock: { mode: 'pessimistic_write' },
  });
  if (!playlist) {
    throw studioError('studio_playlist_not_found');
  }
  return playlist;
}

export async function lockPlaylistFor(
  manager: EntityManager,
  playlistId: string,
  userId: string,
  required: StudioPlaylistWriteRole,
): Promise<LockedPlaylist> {
  const playlist = await lockPlaylistRow(manager, playlistId);
  if (playlist.userId === userId) {
    return { playlist, role: 'owner' };
  }
  if (required === 'owner') {
    throw new StudioPlaylistRoleRefusal();
  }
  const editorRows: { id: string }[] = await manager.query(
    LOCK_ACTIVE_EDITOR_ROW_SQL,
    [playlistId, userId, playlist.userId],
  );
  if (!editorRows.length) {
    throw new StudioPlaylistRoleRefusal();
  }
  return { playlist, role: 'editor' };
}

/** The HTTP answer to a refusal: 403 when the caller can open the
 *  playlist, 404 when they cannot, so a refusal never confirms that a
 *  playlist they cannot see exists. */
export async function playlistRoleRefusal(
  isOpenToViewer: () => Promise<boolean>,
): Promise<HttpException> {
  return (await isOpenToViewer())
    ? studioError('studio_playlist_owner_only')
    : studioError('studio_playlist_not_found');
}
