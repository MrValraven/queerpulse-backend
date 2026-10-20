import {
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager } from 'typeorm';
import {
  StudioPlaylist,
  StudioPlaylistVisibility,
} from './entities/studio-playlist.entity';
import {
  LOCK_ACTIVE_EDITOR_ROW_SQL,
  PLAYLIST_CREDIT_STANDS_SQL,
  StudioPlaylistRoleRefusal,
  isPlaylistCreditStanding,
  lockPlaylistFor,
  lockPlaylistRow,
  playlistRoleRefusal,
} from './studio-playlist-roles';
import {
  creditStandsSql,
  playlistOwnerIsActiveSql,
} from './studio-playlist-visibility';

const OWNER_ID = 'c9000000-0000-4000-8000-000000000001';
const EDITOR_ID = 'c9000000-0000-4000-8000-000000000002';
const STRANGER_ID = 'c9000000-0000-4000-8000-000000000003';
const PLAYLIST_ID = 'c9100000-0000-4000-8000-000000000001';

const playlistRow = (): StudioPlaylist =>
  ({
    id: PLAYLIST_ID,
    userId: OWNER_ID,
    name: 'Night bus',
    description: null,
    visibility: StudioPlaylistVisibility.Private,
    creditSubprofileId: null,
    isCreditedToPersona: false,
  }) as StudioPlaylist;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code?: string }).code;
  }
}

describe('Studio playlist roles', () => {
  let findOne: jest.Mock;
  let query: jest.Mock;
  let manager: EntityManager;
  let activeEditorIds: Set<string>;

  beforeEach(() => {
    activeEditorIds = new Set([EDITOR_ID]);
    findOne = jest.fn().mockResolvedValue(playlistRow());
    query = jest.fn((sql: string, parameters: unknown[]) =>
      Promise.resolve(
        sql === LOCK_ACTIVE_EDITOR_ROW_SQL &&
          activeEditorIds.has(parameters[1] as string)
          ? [{ id: 'editor-row-1' }]
          : [],
      ),
    );
    manager = { findOne, query } as unknown as EntityManager;
  });

  it('locks the playlist row for the write', async () => {
    await lockPlaylistRow(manager, PLAYLIST_ID);
    expect(findOne).toHaveBeenCalledWith(StudioPlaylist, {
      where: { id: PLAYLIST_ID },
      lock: { mode: 'pessimistic_write' },
    });
  });

  it('answers 404 with the playlist code for a playlist that does not exist', async () => {
    findOne.mockResolvedValue(null);
    await expect(
      lockPlaylistFor(manager, PLAYLIST_ID, OWNER_ID, 'editor'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(
      await codeOf(lockPlaylistFor(manager, PLAYLIST_ID, OWNER_ID, 'owner')),
    ).toBe('studio_playlist_not_found');
  });

  it('admits the owner to both roles without reading the editor table', async () => {
    expect(
      (await lockPlaylistFor(manager, PLAYLIST_ID, OWNER_ID, 'owner')).role,
    ).toBe('owner');
    expect(
      (await lockPlaylistFor(manager, PLAYLIST_ID, OWNER_ID, 'editor')).role,
    ).toBe('owner');
    expect(query).not.toHaveBeenCalled();
  });

  it('admits an active editor to editor writes', async () => {
    const locked = await lockPlaylistFor(
      manager,
      PLAYLIST_ID,
      EDITOR_ID,
      'editor',
    );
    expect(locked.role).toBe('editor');
    expect(query).toHaveBeenCalledWith(LOCK_ACTIVE_EDITOR_ROW_SQL, [
      PLAYLIST_ID,
      EDITOR_ID,
      OWNER_ID,
    ]);
  });

  it('refuses an active editor an owner write before reading the editor table', async () => {
    await expect(
      lockPlaylistFor(manager, PLAYLIST_ID, EDITOR_ID, 'owner'),
    ).rejects.toBeInstanceOf(StudioPlaylistRoleRefusal);
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses a member with no active row an editor write', async () => {
    await expect(
      lockPlaylistFor(manager, PLAYLIST_ID, STRANGER_ID, 'editor'),
    ).rejects.toBeInstanceOf(StudioPlaylistRoleRefusal);
  });

  it('reads the active editor row under a share lock and refuses a pair blocked either way', () => {
    expect(LOCK_ACTIVE_EDITOR_ROW_SQL).toContain(
      `"editor"."status" = 'active'`,
    );
    expect(LOCK_ACTIVE_EDITOR_ROW_SQL).toContain('FOR SHARE OF "editor"');
    expect(LOCK_ACTIVE_EDITOR_ROW_SQL).toContain(
      `("editor_block"."blocker_id" = $2 AND "editor_block"."blocked_id" = $3)`,
    );
    expect(LOCK_ACTIVE_EDITOR_ROW_SQL).toContain(
      `("editor_block"."blocker_id" = $3 AND "editor_block"."blocked_id" = $2)`,
    );
  });

  it('requires the playlist credit to stand before an editor holds the role', () => {
    expect(LOCK_ACTIVE_EDITOR_ROW_SQL).toContain(creditStandsSql('playlist'));
    expect(LOCK_ACTIVE_EDITOR_ROW_SQL).toContain(
      'INNER JOIN "studio_playlists" "playlist"',
    );
  });

  it('requires the owner account to be active before an editor holds the role', () => {
    expect(LOCK_ACTIVE_EDITOR_ROW_SQL).toContain(
      playlistOwnerIsActiveSql('playlist'),
    );
    expect(LOCK_ACTIVE_EDITOR_ROW_SQL).toContain(
      `"playlist_active_owner"."status" = 'active'`,
    );
    expect(
      LOCK_ACTIVE_EDITOR_ROW_SQL.trimEnd().endsWith('FOR SHARE OF "editor"'),
    ).toBe(true);
  });

  it('reads whether the playlist credit stands with the shared credit predicate', () => {
    expect(PLAYLIST_CREDIT_STANDS_SQL).toBe(
      `SELECT ${creditStandsSql('playlist')} AS "is_standing" FROM "studio_playlists" "playlist" WHERE "playlist"."id" = $1`,
    );
  });

  it('answers true for a standing credit and passes the playlist id', async () => {
    query.mockResolvedValue([{ is_standing: true }]);
    expect(await isPlaylistCreditStanding(manager, PLAYLIST_ID)).toBe(true);
    expect(query).toHaveBeenCalledWith(PLAYLIST_CREDIT_STANDS_SQL, [
      PLAYLIST_ID,
    ]);
  });

  it('answers false for a broken credit and for a playlist that does not exist', async () => {
    query.mockResolvedValue([{ is_standing: false }]);
    expect(await isPlaylistCreditStanding(manager, PLAYLIST_ID)).toBe(false);
    query.mockResolvedValue([]);
    expect(await isPlaylistCreditStanding(manager, PLAYLIST_ID)).toBe(false);
  });

  it('refuses an editor whose playlist credit is broken and answers 404 because the playlist is closed to them', async () => {
    query.mockResolvedValue([]);
    await expect(
      lockPlaylistFor(manager, PLAYLIST_ID, EDITOR_ID, 'editor'),
    ).rejects.toBeInstanceOf(StudioPlaylistRoleRefusal);
    const refusal = await playlistRoleRefusal(() => Promise.resolve(false));
    expect(refusal).toBeInstanceOf(NotFoundException);
    expect((refusal.getResponse() as { code: string }).code).toBe(
      'studio_playlist_not_found',
    );
  });

  it('answers 404 to a caller who cannot open the playlist and 403 to one who can', async () => {
    const hidden = await playlistRoleRefusal(() => Promise.resolve(false));
    const visible = await playlistRoleRefusal(() => Promise.resolve(true));
    expect(hidden).toBeInstanceOf(NotFoundException);
    expect((hidden.getResponse() as { code: string }).code).toBe(
      'studio_playlist_not_found',
    );
    expect(visible).toBeInstanceOf(ForbiddenException);
    expect((visible.getResponse() as { code: string }).code).toBe(
      'studio_playlist_owner_only',
    );
  });
});
