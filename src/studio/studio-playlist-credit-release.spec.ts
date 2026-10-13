import { EntityManager } from 'typeorm';
import {
  PLAYLIST_CREDIT_RELEASE_ASSIGNMENTS,
  releasePlaylistCreditsIfPersonaUnlistenable,
  releasePlaylistCreditsOfPersona,
  releasePlaylistCreditsOnTakedown,
} from './studio-playlist-credit-release';

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
});
