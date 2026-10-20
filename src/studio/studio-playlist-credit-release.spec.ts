import { EntityManager } from 'typeorm';
import {
  PLAYLIST_CREDIT_RELEASE_ASSIGNMENTS,
  RELEASE_PLAYLIST_CREDITS_IF_UNLISTENABLE_SQL,
  RELEASE_PLAYLIST_CREDITS_OF_PERSONA_SQL,
  releasePlaylistCreditsIfPersonaUnlistenable,
  releasePlaylistCreditsOfPersona,
  releasePlaylistCreditsOnTakedown,
} from './studio-playlist-credit-release';
import {
  CLEAR_ENDED_EDITOR_ADDED_BY_SQL,
  RELEASED_PLAYLIST_EDITORS_CTE,
} from './studio-playlist-editor-endings';

const PERSONA_ID = '0b9f3c1e-5a52-4c51-9d6e-2f1a7c3b8e40';

describe('Studio playlist credit release', () => {
  let query: jest.Mock<Promise<unknown>, [string, unknown[]?]>;
  let manager: EntityManager;

  beforeEach(() => {
    query = jest
      .fn<Promise<unknown>, [string, unknown[]?]>()
      .mockResolvedValue(undefined);
    manager = { query } as unknown as EntityManager;
  });

  it('turns every playlist credited to the persona private and clears the credit and its flag', async () => {
    await releasePlaylistCreditsOfPersona(manager, PERSONA_ID);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, parameters] = query.mock.calls[0]!;
    expect(sql).toContain('UPDATE "studio_playlists"');
    expect(sql).toContain(PLAYLIST_CREDIT_RELEASE_ASSIGNMENTS);
    expect(sql).toContain(`WHERE "credit_subprofile_id" = $1`);
    expect(parameters).toEqual([PERSONA_ID]);
  });

  it('sets private, a null credit, a cleared flag and a fresh update time', () => {
    expect(PLAYLIST_CREDIT_RELEASE_ASSIGNMENTS).toContain(
      `"visibility" = 'private'`,
    );
    expect(PLAYLIST_CREDIT_RELEASE_ASSIGNMENTS).toContain(
      `"credit_subprofile_id" = NULL`,
    );
    expect(PLAYLIST_CREDIT_RELEASE_ASSIGNMENTS).toContain(
      `"is_credited_to_persona" = false`,
    );
    expect(PLAYLIST_CREDIT_RELEASE_ASSIGNMENTS).toContain(
      `"updated_at" = now()`,
    );
  });

  it('touches the credits only when the persona fails the listenable predicate', async () => {
    await releasePlaylistCreditsIfPersonaUnlistenable(manager, PERSONA_ID);

    const [sql, parameters] = query.mock.calls[0]!;
    expect(sql).toContain('UPDATE "studio_playlists"');
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain(`"credit_persona"."status" = 'published'`);
    expect(sql).toContain(`"credit_persona"."visibility" = 'open'`);
    expect(sql).toContain('content_moderation');
    expect(parameters).toEqual([PERSONA_ID]);
  });

  it('releases the credits of a persona taken down by a moderator', async () => {
    await releasePlaylistCreditsOnTakedown(manager, 'subprofile', PERSONA_ID);
    expect(query.mock.calls[0]?.[1]).toEqual([PERSONA_ID]);
  });

  it('leaves playlists alone for a takedown of anything else', async () => {
    await releasePlaylistCreditsOnTakedown(manager, 'post', PERSONA_ID);
    expect(query).not.toHaveBeenCalled();
  });

  it('skips a persona subject id that is no uuid, so the takedown transaction never fails on a cast', async () => {
    await releasePlaylistCreditsOnTakedown(manager, 'subprofile', 'nightform');
    expect(query).not.toHaveBeenCalled();
  });

  // Collaborative playlists: a released credit ends the co-owner editors of
  // those playlists and clears their added by, in the same statement, so the
  // persona paths that count statements still see one.
  it('ends the co-owner editors of the released playlists in the same statement', async () => {
    await releasePlaylistCreditsOfPersona(manager, PERSONA_ID);
    await releasePlaylistCreditsIfPersonaUnlistenable(manager, PERSONA_ID);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toBe(
      RELEASE_PLAYLIST_CREDITS_OF_PERSONA_SQL,
    );
    expect(query.mock.calls[1]?.[0]).toBe(
      RELEASE_PLAYLIST_CREDITS_IF_UNLISTENABLE_SQL,
    );
    for (const sql of [
      RELEASE_PLAYLIST_CREDITS_OF_PERSONA_SQL,
      RELEASE_PLAYLIST_CREDITS_IF_UNLISTENABLE_SQL,
    ]) {
      expect(sql).toMatch(/^WITH "released_playlist" AS \(/);
      expect(sql).toContain('RETURNING "id"');
      expect(sql).toContain(RELEASED_PLAYLIST_EDITORS_CTE);
      expect(sql).toContain(CLEAR_ENDED_EDITOR_ADDED_BY_SQL);
    }
  });

  it('keeps NOT EXISTS out of the delete and unlink release', () => {
    expect(RELEASE_PLAYLIST_CREDITS_OF_PERSONA_SQL).not.toContain('NOT EXISTS');
  });
});
