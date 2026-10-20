import { UserStatus } from '../users/entities/user.entity';
import {
  StudioPlaylist,
  StudioPlaylistVisibility,
} from './entities/studio-playlist.entity';
import { listenablePersonaSql } from './studio-visibility';
import { episodeReleasedSql } from './studio-episode-rule';
import { STUDIO_ARTIST_PERSONA_KINDS } from './studio.constants';

/*
 * Studio v2: who sees a playlist, spelled once.
 *
 * - The owner always opens their own playlist.
 * - Collaborative playlists: a member with an `invited` or `active` row in
 *   `studio_playlist_editors` opens it too, whatever its visibility and
 *   whatever the owner's grant, while its credit stands, the owner's
 *   account is active and no block holds with the owner. Lists stay as
 *   they are: `publiclyListedPlaylistSql` never reads the editors table.
 * - Everyone else needs: no block either way with the owner, an active
 *   owner who still holds a Studio grant, and a credit that stands. A
 *   persona credit also needs no block either way with the member who
 *   created the persona (`personaCreatorBlockExemptSql`). A member credit
 *   always stands. A persona credit stands while the persona is listenable,
 *   is of a Studio artist kind, and still counts the owner among its members.
 * - Then public opens to any granted member, connections only opens to the
 *   owner's accepted connections, and private opens to nobody.
 * - Lists show public playlists only (`publiclyListedPlaylistSql`); the one
 *   exception, a member profile shown to a connection, is applied by the
 *   reads service with `ConnectionsService.areConnected`.
 *
 * The single-playlist read uses `canViewerOpenPlaylist` with facts gathered
 * through `BlockFilterService.isBlockedEitherWay`, `StudioAccessService
 * .hasAccess` and `ConnectionsService.areConnected`. Bulk reads (saved cards)
 * use `playlistOpenToViewerSql`, which spells the same rule in SQL and checks
 * the same `connections` row `areConnected` reads (either direction,
 * `status = 'accepted'`). Blocks are applied separately with
 * `BlockFilterService.excludeBlocked` on `"<alias>"."user_id"`.
 *
 * Every alias here is a literal from Studio's own query builders; member
 * input never reaches one.
 */

/** Every Studio artist kind of the format map (`STUDIO_FORMAT_BY_KIND`),
 *  quoted for an `IN (...)` list. The one spelling: Studio discovery
 *  re-exports it as `STUDIO_ARTIST_KIND_LIST_SQL`. */
export const ARTIST_KIND_LIST = STUDIO_ARTIST_PERSONA_KINDS.map(
  (kind) => `'${kind}'`,
).join(', ');

/** Studio safety and moderation: a track no copyright claim holds offline. */
export function notWithheldTrackSql(trackAlias: string): string {
  return `"${trackAlias}"."withheld_at" IS NULL`;
}

/** Published release, audio in place and (Studio artist kinds) a podcast
 *  episode that has been published (`episodeReleasedSql`), whether or not a
 *  claim holds the track. Only claim filing reads it alone, so a second
 *  rights holder can file while another claim holds the track. A bare AND
 *  chain. */
export function releasedTrackAudioSql(
  trackAlias: string,
  releaseAlias: string,
): string {
  const track = `"${trackAlias}"`;
  const release = `"${releaseAlias}"`;
  return `${release}."status" = 'published'
    AND ${track}."audio_key" IS NOT NULL
    AND ${track}."duration_seconds" IS NOT NULL
    AND ${episodeReleasedSql(trackAlias, releaseAlias)}`;
}

/** The release and audio half of `playableTrackSql`: the released rule
 *  above, and (Studio safety) no copyright claim holding the track. Studio
 *  discovery's related-artist score reads it and checks the persona once per
 *  candidate. It is a bare AND chain, so `playableTrackSql` keeps its shape;
 *  a caller places it inside an AND list or wraps it in parentheses before
 *  any OR. The listener tracklist of a release reads the released rule and
 *  redacts a withheld row in place (`toListenerTrackSummaries`). */
export function playableTrackAudioSql(
  trackAlias: string,
  releaseAlias: string,
): string {
  return `${releasedTrackAudioSql(trackAlias, releaseAlias)}
    AND ${notWithheldTrackSql(trackAlias)}`;
}

/** A track a listener can play: published release, audio in place, and a
 *  listenable persona. Blocks are added by the caller. */
export function playableTrackSql(
  trackAlias: string,
  releaseAlias: string,
  personaAlias: string,
): string {
  return `(${playableTrackAudioSql(trackAlias, releaseAlias)}
    AND ${listenablePersonaSql(personaAlias)})`;
}

/** A persona credit that stands right now. */
export function personaCreditActiveSql(playlistAlias: string): string {
  const playlist = `"${playlistAlias}"`;
  return `(${playlist}."is_credited_to_persona"
    AND ${playlist}."credit_subprofile_id" IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "subprofiles" "credit_persona"
       INNER JOIN "subprofile_members" "credit_member"
          ON "credit_member"."subprofile_id" = "credit_persona"."id"
         AND "credit_member"."user_id" = ${playlist}."user_id"
       WHERE "credit_persona"."id" = ${playlist}."credit_subprofile_id"
         AND "credit_persona"."kind" IN (${ARTIST_KIND_LIST})
         AND ${listenablePersonaSql('credit_persona')}
    ))`;
}

/** A member credit, or a persona credit that stands. */
export function creditStandsSql(playlistAlias: string): string {
  return `(NOT "${playlistAlias}"."is_credited_to_persona" OR ${personaCreditActiveSql(playlistAlias)})`;
}

/** An owner whose account is active and who holds a Studio grant. A
 *  suspended, paused or erased owner lists nowhere for anyone else. */
export function ownerHoldsGrantSql(playlistAlias: string): string {
  return `EXISTS (
      SELECT 1 FROM "studio_access_grants" "playlist_owner_grant"
       INNER JOIN "users" "playlist_owner"
          ON "playlist_owner"."id" = "playlist_owner_grant"."user_id"
         AND "playlist_owner"."status" = '${UserStatus.Active}'
       WHERE "playlist_owner_grant"."user_id" = "${playlistAlias}"."user_id"
    )`;
}

/** The playlist owner's account is active (the same `users.status` check
 *  `ownerHoldsGrantSql` and the single-playlist read make). A paused,
 *  deletion pending or suspended owner closes the playlist to its editors
 *  and invitees too. */
export function playlistOwnerIsActiveSql(playlistAlias: string): string {
  return `EXISTS (
      SELECT 1 FROM "users" "playlist_active_owner"
       WHERE "playlist_active_owner"."id" = "${playlistAlias}"."user_id"
         AND "playlist_active_owner"."status" = '${UserStatus.Active}'
    )`;
}

/** The user id of the member who created the persona a playlist is
 *  credited to, as a scalar subquery; NULL for a member credit. Pass it to
 *  `BlockFilterService.excludeBlocked` as the member column. */
export function creditPersonaCreatorIdSql(playlistAlias: string): string {
  return `(SELECT "credit_creator"."user_id" FROM "subprofiles" "credit_creator" WHERE "credit_creator"."id" = "${playlistAlias}"."credit_subprofile_id")`;
}

/** The `unless` for that block filter: a member credit carries no persona,
 *  and the owner always reads their own playlist. `viewerParameterName` is
 *  a parameter the query builder already binds to the viewer. */
export function personaCreatorBlockExemptSql(
  playlistAlias: string,
  viewerParameterName: string,
): string {
  return `("${playlistAlias}"."credit_subprofile_id" IS NULL OR "${playlistAlias}"."user_id" = :${viewerParameterName})`;
}

/** Search, the persona page, the track page and the stats count read this. */
export function publiclyListedPlaylistSql(playlistAlias: string): string {
  return `("${playlistAlias}"."visibility" = '${StudioPlaylistVisibility.Public}'
    AND ${creditStandsSql(playlistAlias)}
    AND ${ownerHoldsGrantSql(playlistAlias)})`;
}

/** The two live editor statuses, quoted for an `IN (...)` list. */
export const LIVE_EDITOR_STATUS_LIST = `'invited', 'active'`;

/** The viewer holds an `invited` or `active` editor row on the playlist.
 *  `viewerParameterName` is bound by the caller. */
export function viewerHoldsLiveEditorRowSql(
  playlistAlias: string,
  viewerParameterName: string,
): string {
  return `EXISTS (
      SELECT 1 FROM "studio_playlist_editors" "viewer_editor_row"
       WHERE "viewer_editor_row"."playlist_id" = "${playlistAlias}"."id"
         AND "viewer_editor_row"."user_id" = :${viewerParameterName}
         AND "viewer_editor_row"."status" IN (${LIVE_EDITOR_STATUS_LIST})
    )`;
}

/** The viewer actively edits the playlist (`GET /studio/playlists/mine`). */
export function viewerEditsPlaylistSql(
  playlistAlias: string,
  viewerParameterName: string,
): string {
  return `EXISTS (
      SELECT 1 FROM "studio_playlist_editors" "viewer_active_editor_row"
       WHERE "viewer_active_editor_row"."playlist_id" = "${playlistAlias}"."id"
         AND "viewer_active_editor_row"."user_id" = :${viewerParameterName}
         AND "viewer_active_editor_row"."status" = 'active'
    )`;
}

/** The direct-link rule in SQL, for bulk reads. `viewerParameterName` is
 *  bound by the caller (TypeORM replaces every occurrence). A live editor
 *  row opens the playlist while its credit stands and its owner's account
 *  is active; blocks are applied by the caller as before. */
export function playlistOpenToViewerSql(
  playlistAlias: string,
  viewerParameterName: string,
): string {
  const playlist = `"${playlistAlias}"`;
  const viewer = `:${viewerParameterName}`;
  return `(${playlist}."user_id" = ${viewer}
    OR (${viewerHoldsLiveEditorRowSql(playlistAlias, viewerParameterName)}
      AND ${creditStandsSql(playlistAlias)}
      AND ${playlistOwnerIsActiveSql(playlistAlias)})
    OR (${ownerHoldsGrantSql(playlistAlias)}
      AND ${creditStandsSql(playlistAlias)}
      AND (${playlist}."visibility" = '${StudioPlaylistVisibility.Public}'
        OR (${playlist}."visibility" = '${StudioPlaylistVisibility.Connections}'
          AND EXISTS (
            SELECT 1 FROM "connections" "playlist_connection"
             WHERE "playlist_connection"."status" = 'accepted'
               AND (
                 ("playlist_connection"."requester_id" = ${viewer}
                   AND "playlist_connection"."addressee_id" = ${playlist}."user_id")
                 OR ("playlist_connection"."addressee_id" = ${viewer}
                   AND "playlist_connection"."requester_id" = ${playlist}."user_id")
               )
          )))))`;
}

/** What a viewer reads: a credit that stopped standing reads as private. */
export function effectivePlaylistVisibility(
  visibility: StudioPlaylistVisibility,
  isCreditBroken: boolean,
): StudioPlaylistVisibility {
  return isCreditBroken ? StudioPlaylistVisibility.Private : visibility;
}

export interface PlaylistAudienceFacts {
  isOwner: boolean;
  /** As stored; the credit decides what it reads as. */
  visibility: StudioPlaylistVisibility;
  isCreditBroken: boolean;
  hasOwnerGrant: boolean;
  isBlockedEitherWay: boolean;
  isConnectedToOwner: boolean;
  /** Collaborative playlists: the viewer holds an `invited` or `active`
   *  editor row. Optional, so callers that predate editors read false. */
  hasLiveEditorRow?: boolean;
}

/** The direct-link rule for one playlist. */
export function canViewerOpenPlaylist(facts: PlaylistAudienceFacts): boolean {
  if (facts.isOwner) {
    return true;
  }
  if (facts.isBlockedEitherWay) {
    return false;
  }
  // An editor or invitee opens any visibility, owner grant or none, while
  // the credit stands.
  if (facts.hasLiveEditorRow) {
    return !facts.isCreditBroken;
  }
  if (!facts.hasOwnerGrant) {
    return false;
  }
  const visibility = effectivePlaylistVisibility(
    facts.visibility,
    facts.isCreditBroken,
  );
  if (visibility === StudioPlaylistVisibility.Public) {
    return true;
  }
  if (visibility === StudioPlaylistVisibility.Connections) {
    return facts.isConnectedToOwner;
  }
  return false;
}

/** A persona credit whose playlist id the standing set (read with
 *  `personaCreditActiveSql`) does not hold. A member credit never breaks. */
export function isPlaylistCreditBroken(
  playlist: Pick<StudioPlaylist, 'id' | 'isCreditedToPersona'>,
  standingPersonaCreditIds: ReadonlySet<string>,
): boolean {
  return (
    playlist.isCreditedToPersona && !standingPersonaCreditIds.has(playlist.id)
  );
}
