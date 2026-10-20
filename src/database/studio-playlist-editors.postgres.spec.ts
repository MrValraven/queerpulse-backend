// Lives in `src/database` beside the other Postgres specs.
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { StudioPlaylist } from '../studio/entities/studio-playlist.entity';
import { releasePlaylistCreditsOfPersona } from '../studio/studio-playlist-credit-release';
import {
  endEditingBetweenMembers,
  endEditorsOnPlaylist,
  endPlaylistEditingOfCoOwner,
} from '../studio/studio-playlist-editor-endings';
import { mineListedPlaylistSql } from '../studio/studio-playlist-reads.service';
import {
  playlistOpenToViewerSql,
  publiclyListedPlaylistSql,
} from '../studio/studio-playlist-visibility';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import {
  Subprofile,
  SubprofileKind,
  SubprofileStatus,
  SubprofileVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * Collaborative playlists on real Postgres: who opens a playlist by link,
 * that public lists ignore editor rows, the `GET mine` keyset over owned,
 * edited and invited playlists, and every automatic ending with its
 * "added by" clear.
 * Skipped unless `STUDIO_MIGRATIONS_DATABASE_URL` names a database whose
 * name ends in `_test` (it drops and synchronizes the schema).
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const OWNER = 'cb000000-0000-4000-8000-000000000001';
const EDITOR = 'cb000000-0000-4000-8000-000000000002';
const INVITEE = 'cb000000-0000-4000-8000-000000000003';
const CO_OWNER = 'cb000000-0000-4000-8000-000000000004';
const DECLINER = 'cb000000-0000-4000-8000-000000000005';
const LIVE_PERSONA = 'cb100000-0000-4000-8000-000000000001';
// Ids sort in the order the assertions list them.
const PERSONA_PLAYLIST = 'cb200000-0000-4000-8000-000000000001';
const PRIVATE_MEMBER = 'cb200000-0000-4000-8000-000000000002';
const PUBLIC_MEMBER = 'cb200000-0000-4000-8000-000000000003';
const EDITOR_OWN = 'cb200000-0000-4000-8000-000000000004';
const EDITED_ELSEWHERE = 'cb200000-0000-4000-8000-000000000005';
const OWNER_ENTRY = 'cb300000-0000-4000-8000-000000000001';
const CO_OWNER_ENTRY = 'cb300000-0000-4000-8000-000000000002';
const EDITOR_ENTRY = 'cb300000-0000-4000-8000-000000000003';

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

interface SeatRow {
  playlist_id: string;
  user_id: string;
  status: string;
  has_ended_at: boolean;
}

describeWithDatabase('Studio playlist editors on real Postgres', () => {
  let dataSource: DataSource;

  const playlistIdsWhere = async (
    predicate: string,
    parameters: Record<string, unknown> = {},
  ): Promise<string[]> => {
    const rows = await dataSource
      .getRepository(StudioPlaylist)
      .createQueryBuilder('playlist')
      .select('"playlist"."id"', 'id')
      .where(predicate, parameters)
      .orderBy('"playlist"."id"', 'ASC')
      .getRawMany<{ id: string }>();
    return rows.map((row) => row.id);
  };

  const seats = async (): Promise<SeatRow[]> =>
    dataSource.query<SeatRow[]>(
      `SELECT "playlist_id", "user_id", "status"::text AS "status",
              "ended_at" IS NOT NULL AS "has_ended_at"
         FROM "studio_playlist_editors"
        ORDER BY "playlist_id", "user_id"`,
    );

  const addedByOf = async (entryId: string): Promise<string | null> => {
    const rows = await dataSource.query<{ added_by_user_id: string | null }[]>(
      `SELECT "added_by_user_id" FROM "studio_playlist_tracks" WHERE "id" = $1`,
      [entryId],
    );
    return rows[0]?.added_by_user_id ?? null;
  };

  // Users are seeded once, so a test that changes a status puts it back.
  const withOwnerStatus = async (
    status: UserStatus,
    run: () => Promise<void>,
  ): Promise<void> => {
    await dataSource.getRepository(User).update({ id: OWNER }, { status });
    try {
      await run();
    } finally {
      await dataSource
        .getRepository(User)
        .update({ id: OWNER }, { status: UserStatus.Active });
    }
  };

  beforeAll(async () => {
    refuseUnlessTestDatabase(DATABASE_URL!);
    dataSource = new DataSource({
      type: 'postgres',
      url: DATABASE_URL,
      entities: [`${__dirname}/../**/*.entity.ts`],
      namingStrategy: new SnakeNamingStrategy(),
      dropSchema: true,
      synchronize: true,
    });
    await dataSource.initialize();
    const everyMember = [OWNER, EDITOR, INVITEE, CO_OWNER, DECLINER];
    await dataSource.getRepository(User).insert(
      everyMember.map((userId) => ({
        id: userId,
        googleId: `google-${userId}`,
        email: `${userId}@example.test`,
        status: UserStatus.Active,
      })),
    );
    await dataSource.query(
      `INSERT INTO "studio_access_grants" ("user_id") SELECT unnest($1::uuid[])`,
      [everyMember],
    );
    await dataSource.getRepository(Subprofile).insert({
      id: LIVE_PERSONA,
      userId: OWNER,
      slug: 'night-shift',
      handle: 'night-shift',
      displayName: 'Night Shift',
      kind: SubprofileKind.Dj,
      status: SubprofileStatus.Published,
      visibility: SubprofileVisibility.Open,
    });
  }, 120000);

  // Every test starts from the same playlists, seats and entries.
  beforeEach(async () => {
    await dataSource.query(`DELETE FROM "studio_playlists"`);
    await dataSource.query(`DELETE FROM "subprofile_members"`);
    await dataSource.getRepository(SubprofileMember).insert([
      { subprofileId: LIVE_PERSONA, userId: OWNER },
      { subprofileId: LIVE_PERSONA, userId: CO_OWNER },
    ]);
    await dataSource.query(
      `INSERT INTO "studio_playlists"
         ("id", "user_id", "name", "visibility", "credit_subprofile_id", "is_credited_to_persona", "updated_at")
       VALUES ($1, $6, 'As the persona', 'public', $8, true, '2026-10-14T06:00:00Z'),
              ($2, $6, 'Just us', 'private', NULL, false, '2026-10-14T08:00:00Z'),
              ($3, $6, 'Out loud', 'public', NULL, false, '2026-10-14T07:00:00Z'),
              ($4, $7, 'Mine', 'private', NULL, false, '2026-10-14T09:00:00Z'),
              ($5, $9, 'Elsewhere', 'private', NULL, false, '2026-10-14T10:00:00Z')`,
      [
        PERSONA_PLAYLIST,
        PRIVATE_MEMBER,
        PUBLIC_MEMBER,
        EDITOR_OWN,
        EDITED_ELSEWHERE,
        OWNER,
        EDITOR,
        LIVE_PERSONA,
        DECLINER,
      ],
    );
    await dataSource.query(
      `INSERT INTO "studio_playlist_editors"
         ("playlist_id", "user_id", "invited_by_user_id", "source", "status", "accepted_at", "ended_at")
       VALUES ($1, $5, $4, 'member_invite', 'active', now(), NULL),
              ($1, $6, $4, 'member_invite', 'invited', NULL, NULL),
              ($1, $7, $4, 'member_invite', 'declined', NULL, now()),
              ($2, $8, $4, 'persona_co_owner', 'active', now(), NULL),
              ($3, $5, $7, 'member_invite', 'active', now(), NULL)`,
      [
        PRIVATE_MEMBER,
        PERSONA_PLAYLIST,
        EDITED_ELSEWHERE,
        OWNER,
        EDITOR,
        INVITEE,
        DECLINER,
        CO_OWNER,
      ],
    );
    await dataSource.query(
      `INSERT INTO "studio_playlist_tracks" ("id", "playlist_id", "track_id", "position", "added_by_user_id")
       VALUES ($1, $4, NULL, 1, $6),
              ($2, $4, NULL, 2, $7),
              ($3, $5, NULL, 1, $8)`,
      [
        OWNER_ENTRY,
        CO_OWNER_ENTRY,
        EDITOR_ENTRY,
        PERSONA_PLAYLIST,
        PRIVATE_MEMBER,
        OWNER,
        CO_OWNER,
        EDITOR,
      ],
    );
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('opens a private playlist by link to an active editor and an invitee, and to nobody whose seat ended', async () => {
    const openTo = (viewerId: string): Promise<string[]> =>
      playlistIdsWhere(playlistOpenToViewerSql('playlist', 'viewerId'), {
        viewerId,
      });

    expect(await openTo(EDITOR)).toContain(PRIVATE_MEMBER);
    expect(await openTo(INVITEE)).toContain(PRIVATE_MEMBER);
    expect(await openTo(DECLINER)).not.toContain(PRIVATE_MEMBER);
  });

  it('closes a playlist to its editor and invitee while the owner account is paused', async () => {
    const openTo = (viewerId: string): Promise<string[]> =>
      playlistIdsWhere(playlistOpenToViewerSql('playlist', 'viewerId'), {
        viewerId,
      });

    await withOwnerStatus(UserStatus.Deactivated, async () => {
      expect(await openTo(EDITOR)).not.toContain(PRIVATE_MEMBER);
      expect(await openTo(INVITEE)).not.toContain(PRIVATE_MEMBER);
    });
    expect(await openTo(EDITOR)).toContain(PRIVATE_MEMBER);
  });

  it('opens a persona playlist to its co-owner editor while the credit stands, and closes it once the owner leaves the persona', async () => {
    const openToCoOwner = (): Promise<string[]> =>
      playlistIdsWhere(playlistOpenToViewerSql('playlist', 'viewerId'), {
        viewerId: CO_OWNER,
      });
    await dataSource.query(
      `UPDATE "studio_playlists" SET "visibility" = 'private' WHERE "id" = $1`,
      [PERSONA_PLAYLIST],
    );
    expect(await openToCoOwner()).toContain(PERSONA_PLAYLIST);

    await dataSource.query(
      `DELETE FROM "subprofile_members" WHERE "user_id" = $1`,
      [OWNER],
    );
    expect(await openToCoOwner()).not.toContain(PERSONA_PLAYLIST);
  });

  it('lists the same public playlists whatever editor rows exist', async () => {
    expect(
      await playlistIdsWhere(publiclyListedPlaylistSql('playlist')),
    ).toEqual([PERSONA_PLAYLIST, PUBLIC_MEMBER]);
    await dataSource.query(`DELETE FROM "studio_playlist_editors"`);
    expect(
      await playlistIdsWhere(publiclyListedPlaylistSql('playlist')),
    ).toEqual([PERSONA_PLAYLIST, PUBLIC_MEMBER]);
  });

  it('pages owned, edited and invited playlists together on one keyset, ended seats left out', async () => {
    const minePage = async (
      viewerId: string,
      cursor: { updatedAt: Date; id: string } | null,
    ): Promise<StudioPlaylist[]> => {
      const queryBuilder = dataSource
        .getRepository(StudioPlaylist)
        .createQueryBuilder('playlist')
        .where(mineListedPlaylistSql('playlist', 'mineViewerId'), {
          mineViewerId: viewerId,
        });
      if (cursor) {
        queryBuilder.andWhere(
          '("playlist"."updated_at", "playlist"."id") < (:cursorUpdatedAt, :cursorId)',
          { cursorUpdatedAt: cursor.updatedAt, cursorId: cursor.id },
        );
      }
      return queryBuilder
        .orderBy('playlist.updatedAt', 'DESC')
        .addOrderBy('playlist.id', 'DESC')
        .limit(2)
        .getMany();
    };

    const firstPage = await minePage(EDITOR, null);
    expect(firstPage.map((playlist) => playlist.id)).toEqual([
      EDITED_ELSEWHERE,
      EDITOR_OWN,
    ]);
    const lastRow = firstPage[1]!;
    const secondPage = await minePage(EDITOR, {
      updatedAt: lastRow.updatedAt,
      id: lastRow.id,
    });
    expect(secondPage.map((playlist) => playlist.id)).toEqual([PRIVATE_MEMBER]);
    const idsOf = (page: StudioPlaylist[]): string[] =>
      page.map((playlist) => playlist.id);
    expect(idsOf(await minePage(INVITEE, null))).toEqual([PRIVATE_MEMBER]);
    expect(idsOf(await minePage(DECLINER, null))).toEqual([EDITED_ELSEWHERE]);
    expect(idsOf(await minePage(CO_OWNER, null))).toEqual([PERSONA_PLAYLIST]);
  });

  it('drops a seated playlist from mine while the owner is paused or the credit stops standing', async () => {
    const mineIds = (viewerId: string): Promise<string[]> =>
      playlistIdsWhere(mineListedPlaylistSql('playlist', 'mineViewerId'), {
        mineViewerId: viewerId,
      });

    await withOwnerStatus(UserStatus.Deactivated, async () => {
      expect(await mineIds(EDITOR)).toEqual([EDITOR_OWN, EDITED_ELSEWHERE]);
      expect(await mineIds(INVITEE)).toEqual([]);
      expect(await mineIds(OWNER)).toEqual([
        PERSONA_PLAYLIST,
        PRIVATE_MEMBER,
        PUBLIC_MEMBER,
      ]);
    });

    await dataSource.query(
      `DELETE FROM "subprofile_members" WHERE "user_id" = $1`,
      [OWNER],
    );
    expect(await mineIds(CO_OWNER)).toEqual([]);
  });

  it('ends co-owner editors and their added by when the persona credit is released', async () => {
    await releasePlaylistCreditsOfPersona(dataSource.manager, LIVE_PERSONA);

    expect((await seats()).find((seat) => seat.user_id === CO_OWNER)).toEqual({
      playlist_id: PERSONA_PLAYLIST,
      user_id: CO_OWNER,
      status: 'revoked',
      has_ended_at: true,
    });
    expect(await addedByOf(CO_OWNER_ENTRY)).toBeNull();
    expect(await addedByOf(OWNER_ENTRY)).toBe(OWNER);
    expect(await addedByOf(EDITOR_ENTRY)).toBe(EDITOR);
  });

  it('ends a departing co-owner seat and clears their added by', async () => {
    await endPlaylistEditingOfCoOwner(
      dataSource.manager,
      LIVE_PERSONA,
      CO_OWNER,
    );

    expect(
      (await seats()).find((seat) => seat.user_id === CO_OWNER)?.status,
    ).toBe('revoked');
    expect(await addedByOf(CO_OWNER_ENTRY)).toBeNull();
    expect(await addedByOf(OWNER_ENTRY)).toBe(OWNER);
  });

  it('ends every co-owner seat on the playlists of an owner who leaves the persona', async () => {
    await endPlaylistEditingOfCoOwner(dataSource.manager, LIVE_PERSONA, OWNER);

    expect(
      (await seats()).find((seat) => seat.user_id === CO_OWNER)?.status,
    ).toBe('revoked');
    expect(
      (await seats()).find(
        (seat) =>
          seat.user_id === EDITOR && seat.playlist_id === PRIVATE_MEMBER,
      )?.status,
    ).toBe('active');
  });

  it('ends the seats between two members after a block, either order, and leaves the rest alone', async () => {
    await endEditingBetweenMembers(dataSource.manager, EDITOR, OWNER);

    const afterBlock = await seats();
    expect(
      afterBlock.find(
        (seat) =>
          seat.user_id === EDITOR && seat.playlist_id === PRIVATE_MEMBER,
      )?.status,
    ).toBe('revoked');
    expect(
      afterBlock.find(
        (seat) =>
          seat.user_id === EDITOR && seat.playlist_id === EDITED_ELSEWHERE,
      )?.status,
    ).toBe('active');
    expect(afterBlock.find((seat) => seat.user_id === INVITEE)?.status).toBe(
      'invited',
    );
    expect(await addedByOf(EDITOR_ENTRY)).toBeNull();

    await endEditingBetweenMembers(dataSource.manager, OWNER, INVITEE);
    expect(
      (await seats()).find((seat) => seat.user_id === INVITEE)?.status,
    ).toBe('revoked');
  });

  it('ends a leaving editor as left, clears only their added by, and leaves an ended seat alone', async () => {
    await endEditorsOnPlaylist(
      dataSource.manager,
      PRIVATE_MEMBER,
      [EDITOR, DECLINER],
      'left',
    );

    const afterLeave = await seats();
    expect(
      afterLeave.find(
        (seat) =>
          seat.user_id === EDITOR && seat.playlist_id === PRIVATE_MEMBER,
      )?.status,
    ).toBe('left');
    expect(afterLeave.find((seat) => seat.user_id === DECLINER)?.status).toBe(
      'declined',
    );
    expect(await addedByOf(EDITOR_ENTRY)).toBeNull();
  });
});
