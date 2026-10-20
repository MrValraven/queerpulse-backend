import { EntityManager } from 'typeorm';
import {
  CLEAR_ENDED_EDITOR_ADDED_BY_SQL,
  END_EDITING_BETWEEN_MEMBERS_SQL,
  END_EDITORS_ON_PLAYLIST_SQL,
  END_PLAYLIST_EDITING_OF_CO_OWNER_SQL,
  RELEASED_PLAYLIST_EDITORS_CTE,
  endEditingBetweenMembers,
  endEditorsOnPlaylist,
  endPlaylistEditingOfCoOwner,
} from './studio-playlist-editor-endings';

const PLAYLIST_ID = 'c8000000-0000-4000-8000-000000000001';
const PERSONA_ID = 'c8100000-0000-4000-8000-000000000001';
const OWNER_ID = 'c8200000-0000-4000-8000-000000000001';
const EDITOR_ID = 'c8200000-0000-4000-8000-000000000002';

describe('Studio playlist editor endings', () => {
  let query: jest.Mock<Promise<unknown>, [string, unknown[]?]>;
  let manager: EntityManager;

  beforeEach(() => {
    query = jest
      .fn<Promise<unknown>, [string, unknown[]?]>()
      .mockResolvedValue([]);
    manager = { query } as unknown as EntityManager;
  });

  it('clears the added by of exactly the ended pairs', () => {
    expect(CLEAR_ENDED_EDITOR_ADDED_BY_SQL).toContain(
      `SET "added_by_user_id" = NULL`,
    );
    expect(CLEAR_ENDED_EDITOR_ADDED_BY_SQL).toContain(
      `"entry"."playlist_id" = "ended_editor"."playlist_id"`,
    );
    expect(CLEAR_ENDED_EDITOR_ADDED_BY_SQL).toContain(
      `"entry"."added_by_user_id" = "ended_editor"."user_id"`,
    );
  });

  it('ends the named live seats on one playlist with the status given, in one statement', async () => {
    await endEditorsOnPlaylist(manager, PLAYLIST_ID, [EDITOR_ID], 'left');

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(END_EDITORS_ON_PLAYLIST_SQL, [
      PLAYLIST_ID,
      [EDITOR_ID],
      'left',
    ]);
    expect(END_EDITORS_ON_PLAYLIST_SQL).toContain(
      `"editor"."status" IN ('invited', 'active')`,
    );
    expect(END_EDITORS_ON_PLAYLIST_SQL).toContain(
      CLEAR_ENDED_EDITOR_ADDED_BY_SQL,
    );
  });

  it('runs nothing for an empty list of members', async () => {
    await endEditorsOnPlaylist(manager, PLAYLIST_ID, [], 'revoked');
    expect(query).not.toHaveBeenCalled();
  });

  it('ends a departing co-owner on the persona playlists, and every co-owner on the playlists they own', async () => {
    await endPlaylistEditingOfCoOwner(manager, PERSONA_ID, EDITOR_ID);

    expect(query).toHaveBeenCalledWith(END_PLAYLIST_EDITING_OF_CO_OWNER_SQL, [
      PERSONA_ID,
      EDITOR_ID,
    ]);
    expect(END_PLAYLIST_EDITING_OF_CO_OWNER_SQL).toContain(
      `"credited_playlist"."credit_subprofile_id" = $1`,
    );
    expect(END_PLAYLIST_EDITING_OF_CO_OWNER_SQL).toContain(
      `("editor"."user_id" = $2 OR "credited_playlist"."user_id" = $2)`,
    );
    expect(END_PLAYLIST_EDITING_OF_CO_OWNER_SQL).toContain(
      `"editor"."source" = 'persona_co_owner'`,
    );
    expect(END_PLAYLIST_EDITING_OF_CO_OWNER_SQL).toContain(
      `"status" = 'revoked'`,
    );
  });

  it('ends the seats between two members in both directions after a block', async () => {
    await endEditingBetweenMembers(manager, OWNER_ID, EDITOR_ID);

    expect(query).toHaveBeenCalledWith(END_EDITING_BETWEEN_MEMBERS_SQL, [
      OWNER_ID,
      EDITOR_ID,
    ]);
    expect(END_EDITING_BETWEEN_MEMBERS_SQL).toContain(
      `("owned_playlist"."user_id" = $1 AND "editor"."user_id" = $2)`,
    );
    expect(END_EDITING_BETWEEN_MEMBERS_SQL).toContain(
      `("owned_playlist"."user_id" = $2 AND "editor"."user_id" = $1)`,
    );
  });

  it('ends only the persona co-owner seats of the released playlists', () => {
    expect(RELEASED_PLAYLIST_EDITORS_CTE).toContain(
      `"editor"."playlist_id" = "released_playlist"."id"`,
    );
    expect(RELEASED_PLAYLIST_EDITORS_CTE).toContain(
      `"editor"."source" = 'persona_co_owner'`,
    );
  });
});
