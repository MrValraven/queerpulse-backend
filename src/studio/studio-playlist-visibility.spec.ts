import { StudioPlaylistVisibility } from './entities/studio-playlist.entity';
import {
  ARTIST_KIND_LIST,
  LIVE_EDITOR_STATUS_LIST,
  PlaylistAudienceFacts,
  canViewerOpenPlaylist,
  creditPersonaCreatorIdSql,
  creditStandsSql,
  effectivePlaylistVisibility,
  isPlaylistCreditBroken,
  notWithheldTrackSql,
  ownerHoldsGrantSql,
  personaCreatorBlockExemptSql,
  personaCreditActiveSql,
  playableTrackAudioSql,
  playableTrackSql,
  playlistOpenToViewerSql,
  playlistOwnerIsActiveSql,
  publiclyListedPlaylistSql,
  releasedTrackAudioSql,
  viewerEditsPlaylistSql,
  viewerHoldsLiveEditorRowSql,
} from './studio-playlist-visibility';
import { episodeReleasedSql } from './studio-episode-rule';

const facts = (
  overrides: Partial<PlaylistAudienceFacts> = {},
): PlaylistAudienceFacts => ({
  isOwner: false,
  visibility: StudioPlaylistVisibility.Public,
  isCreditBroken: false,
  hasOwnerGrant: true,
  isBlockedEitherWay: false,
  isConnectedToOwner: false,
  ...overrides,
});

describe('canViewerOpenPlaylist', () => {
  it.each([
    ['a public playlist to a granted member', facts(), true],
    [
      'a public playlist to someone blocked either way with its owner',
      facts({ isBlockedEitherWay: true }),
      false,
    ],
    [
      'a public playlist whose owner no longer holds a grant',
      facts({ hasOwnerGrant: false }),
      false,
    ],
    [
      'a public playlist whose persona credit stopped standing',
      facts({ isCreditBroken: true }),
      false,
    ],
    [
      'a connections-only playlist to an accepted connection',
      facts({
        visibility: StudioPlaylistVisibility.Connections,
        isConnectedToOwner: true,
      }),
      true,
    ],
    [
      'a connections-only playlist to a member who is no connection',
      facts({ visibility: StudioPlaylistVisibility.Connections }),
      false,
    ],
    [
      'a connections-only playlist with a broken persona credit to a connection',
      facts({
        visibility: StudioPlaylistVisibility.Connections,
        isConnectedToOwner: true,
        isCreditBroken: true,
      }),
      false,
    ],
    [
      'a connections-only playlist to a connection who is blocked either way',
      facts({
        visibility: StudioPlaylistVisibility.Connections,
        isConnectedToOwner: true,
        isBlockedEitherWay: true,
      }),
      false,
    ],
    [
      'a connections-only playlist to a connection while the owner holds no grant',
      facts({
        visibility: StudioPlaylistVisibility.Connections,
        isConnectedToOwner: true,
        hasOwnerGrant: false,
      }),
      false,
    ],
    [
      'a private playlist to a connection',
      facts({
        visibility: StudioPlaylistVisibility.Private,
        isConnectedToOwner: true,
      }),
      false,
    ],
    [
      'any playlist to its owner, whatever else holds',
      facts({
        isOwner: true,
        visibility: StudioPlaylistVisibility.Private,
        isCreditBroken: true,
        hasOwnerGrant: false,
      }),
      true,
    ],
    [
      'a private playlist to a live editor row whose owner holds no grant',
      facts({
        visibility: StudioPlaylistVisibility.Private,
        hasOwnerGrant: false,
        hasLiveEditorRow: true,
      }),
      true,
    ],
    [
      'a playlist to a live editor row while its persona credit is broken',
      facts({ isCreditBroken: true, hasLiveEditorRow: true }),
      false,
    ],
    [
      'a playlist to a live editor row blocked either way with the owner',
      facts({ isBlockedEitherWay: true, hasLiveEditorRow: true }),
      false,
    ],
  ])('decides %s', (_description, audience, expected) => {
    expect(canViewerOpenPlaylist(audience)).toBe(expected);
  });
});

describe('effectivePlaylistVisibility', () => {
  it('reads a broken persona credit as private and keeps every other choice', () => {
    expect(
      effectivePlaylistVisibility(StudioPlaylistVisibility.Public, true),
    ).toBe(StudioPlaylistVisibility.Private);
    expect(
      effectivePlaylistVisibility(StudioPlaylistVisibility.Connections, true),
    ).toBe(StudioPlaylistVisibility.Private);
    expect(
      effectivePlaylistVisibility(StudioPlaylistVisibility.Connections, false),
    ).toBe(StudioPlaylistVisibility.Connections);
  });
});

describe('isPlaylistCreditBroken', () => {
  it('breaks a persona credit missing from the standing set and never a member credit', () => {
    const standing = new Set(['playlist-1']);
    expect(
      isPlaylistCreditBroken(
        { id: 'playlist-1', isCreditedToPersona: true },
        standing,
      ),
    ).toBe(false);
    expect(
      isPlaylistCreditBroken(
        { id: 'playlist-2', isCreditedToPersona: true },
        standing,
      ),
    ).toBe(true);
    expect(
      isPlaylistCreditBroken(
        { id: 'playlist-2', isCreditedToPersona: false },
        standing,
      ),
    ).toBe(false);
  });
});

describe('playlist SQL predicates', () => {
  it('plays a track only from a published release with audio and a listenable persona', () => {
    const predicate = playableTrackSql('track', 'release', 'persona');
    expect(predicate).toContain(`"release"."status" = 'published'`);
    expect(predicate).toContain(`"track"."audio_key" IS NOT NULL`);
    expect(predicate).toContain(`"track"."duration_seconds" IS NOT NULL`);
    expect(predicate).toContain(`"persona"."handle" IS NOT NULL`);
    expect(predicate).toContain('content_moderation');
  });

  // Studio artist kinds: a podcast episode plays once it is published.
  it('keeps a podcast episode out of every playable read until it is published', () => {
    expect(playableTrackSql('track', 'release', 'persona')).toContain(
      episodeReleasedSql('track', 'release'),
    );
    const audioHalf = playableTrackAudioSql('artist_track', 'artist_release');
    expect(audioHalf).toContain(`"artist_release"."type" <> 'podcast'`);
    expect(audioHalf).toContain(`"artist_track"."published_at" <= now()`);
    expect(audioHalf).toContain(`"artist_release"."status" = 'published'`);
  });

  // Studio safety: a track a copyright claim holds offline plays nowhere.
  it('keeps a withheld track out of every playable read', () => {
    expect(notWithheldTrackSql('track')).toBe('"track"."withheld_at" IS NULL');
    expect(playableTrackAudioSql('artist_track', 'artist_release')).toContain(
      '"artist_track"."withheld_at" IS NULL',
    );
    expect(playableTrackSql('track', 'release', 'persona')).toContain(
      '"track"."withheld_at" IS NULL',
    );
  });

  it('files a claim against a released track whether or not it is withheld', () => {
    const releasedHalf = releasedTrackAudioSql('track', 'release');
    expect(releasedHalf).toContain(`"release"."status" = 'published'`);
    expect(releasedHalf).toContain('"track"."audio_key" IS NOT NULL');
    expect(releasedHalf).toContain(episodeReleasedSql('track', 'release'));
    expect(releasedHalf).not.toContain('withheld_at');
    expect(playableTrackAudioSql('track', 'release')).toContain(releasedHalf);
  });

  it('lets a persona credit stand only for a listenable artist persona the owner still runs', () => {
    const predicate = personaCreditActiveSql('playlist');
    expect(predicate).toContain(`"playlist"."is_credited_to_persona"`);
    expect(predicate).toContain(
      `"playlist"."credit_subprofile_id" IS NOT NULL`,
    );
    expect(predicate).toContain(
      `"credit_member"."user_id" = "playlist"."user_id"`,
    );
    expect(predicate).toContain(
      `"credit_persona"."kind" IN (${ARTIST_KIND_LIST})`,
    );
    expect(predicate).toContain(`"credit_persona"."status" = 'published'`);
    expect(predicate).toContain(`"credit_persona"."visibility" = 'open'`);
  });

  it('lets a member credit stand without any persona check', () => {
    expect(creditStandsSql('playlist')).toMatch(
      /^\(NOT "playlist"\."is_credited_to_persona" OR /,
    );
  });

  it('needs the owner to hold a Studio grant', () => {
    expect(ownerHoldsGrantSql('playlist')).toContain(
      `"playlist_owner_grant"."user_id" = "playlist"."user_id"`,
    );
  });

  it('needs the owner account to be active', () => {
    const predicate = ownerHoldsGrantSql('playlist');
    expect(predicate).toContain(
      `"playlist_owner"."id" = "playlist_owner_grant"."user_id"`,
    );
    expect(predicate).toContain(`"playlist_owner"."status" = 'active'`);
  });

  it('reads the creator of the credited persona as a scalar the block filter can splice', () => {
    expect(creditPersonaCreatorIdSql('playlist')).toBe(
      `(SELECT "credit_creator"."user_id" FROM "subprofiles" "credit_creator" WHERE "credit_creator"."id" = "playlist"."credit_subprofile_id")`,
    );
  });

  it('exempts member credits and the owner from the persona creator block, null safe', () => {
    expect(personaCreatorBlockExemptSql('playlist', 'blockFilterActorId')).toBe(
      `("playlist"."credit_subprofile_id" IS NULL OR "playlist"."user_id" = :blockFilterActorId)`,
    );
  });

  it('lists public playlists only, with a standing credit and a granted owner', () => {
    const predicate = publiclyListedPlaylistSql('playlist');
    expect(predicate).toContain(`"playlist"."visibility" = 'public'`);
    expect(predicate).not.toContain(`'connections'`);
    expect(predicate).toContain(creditStandsSql('playlist'));
    expect(predicate).toContain(ownerHoldsGrantSql('playlist'));
  });

  it('opens a playlist by link to its owner, or as the matrix says, binding the viewer by name', () => {
    const predicate = playlistOpenToViewerSql('playlist', 'savedViewerId');
    expect(predicate).toContain(`"playlist"."user_id" = :savedViewerId`);
    expect(predicate).toContain(`"playlist"."visibility" = 'connections'`);
    expect(predicate).toContain(`"playlist_connection"."status" = 'accepted'`);
    expect(predicate).toContain(
      `"playlist_connection"."requester_id" = :savedViewerId`,
    );
    expect(predicate).toContain(
      `"playlist_connection"."addressee_id" = :savedViewerId`,
    );
    expect(predicate).toContain(creditStandsSql('playlist'));
    expect(predicate).toContain(ownerHoldsGrantSql('playlist'));
    expect(predicate).not.toContain(`'private'`);
  });
});

describe('Studio playlist editor predicates', () => {
  it('spells the live statuses once', () => {
    expect(LIVE_EDITOR_STATUS_LIST).toBe(`'invited', 'active'`);
  });

  it('finds an invited or active row of the viewer on the playlist', () => {
    expect(viewerHoldsLiveEditorRowSql('playlist', 'savedViewerId')).toBe(
      `EXISTS (
      SELECT 1 FROM "studio_playlist_editors" "viewer_editor_row"
       WHERE "viewer_editor_row"."playlist_id" = "playlist"."id"
         AND "viewer_editor_row"."user_id" = :savedViewerId
         AND "viewer_editor_row"."status" IN ('invited', 'active')
    )`,
    );
  });

  it('finds an active row of the viewer for the playlists they edit', () => {
    const predicate = viewerEditsPlaylistSql('playlist', 'mineViewerId');
    expect(predicate).toContain(
      `"viewer_active_editor_row"."status" = 'active'`,
    );
    expect(predicate).toContain(
      `"viewer_active_editor_row"."user_id" = :mineViewerId`,
    );
    expect(predicate).not.toContain(`'invited'`);
  });

  it('reads the owner account as active from the users status', () => {
    expect(playlistOwnerIsActiveSql('playlist')).toBe(
      `EXISTS (
      SELECT 1 FROM "users" "playlist_active_owner"
       WHERE "playlist_active_owner"."id" = "playlist"."user_id"
         AND "playlist_active_owner"."status" = 'active'
    )`,
    );
  });

  it('opens a playlist by link to a live editor row while its credit stands and its owner is active', () => {
    const predicate = playlistOpenToViewerSql('playlist', 'savedViewerId');
    expect(predicate).toContain(
      `(${viewerHoldsLiveEditorRowSql('playlist', 'savedViewerId')}
      AND ${creditStandsSql('playlist')}
      AND ${playlistOwnerIsActiveSql('playlist')})`,
    );
  });

  it('keeps the editors table out of the public list predicate', () => {
    expect(publiclyListedPlaylistSql('playlist')).not.toContain(
      'studio_playlist_editors',
    );
  });

  it('keeps the public list predicate on the grant check alone for the owner', () => {
    expect(publiclyListedPlaylistSql('playlist')).not.toContain(
      'playlist_active_owner',
    );
  });
});
