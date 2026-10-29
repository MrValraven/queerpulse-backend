// Lives in `src/database`, outside `src/migrations`: the TypeORM CLI and
// `DatabaseModule` require every `src/migrations/*.ts` file.
import { DataSource, QueryRunner } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { AddStudioPlaylists1831500000000 } from '../migrations/1831500000000-AddStudioPlaylists';
import { AddStudioReleaseFollowersNotifiedAt1831500100000 } from '../migrations/1831500100000-AddStudioReleaseFollowersNotifiedAt';
import { AddStudioV2EnumValues1831500200000 } from '../migrations/1831500200000-AddStudioV2EnumValues';
import { AddStudioReleaseGenres1838000200000 } from '../migrations/1838000200000-AddStudioReleaseGenres';
import {
  Subprofile,
  SubprofileKind,
} from '../subprofiles/entities/subprofile.entity';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * Studio v2 migrations on real Postgres. Skipped unless
 * `STUDIO_MIGRATIONS_DATABASE_URL` names a database whose name ends in
 * `_test` (it drops and synchronizes the schema). Run it with, for example:
 *
 *   STUDIO_MIGRATIONS_DATABASE_URL=postgres://postgres@127.0.0.1:55450/studio_test \
 *     npx jest src/database/studio-v2-migrations.postgres.spec.ts
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const OWNER_USER = '61000000-0000-4000-8000-000000000001';
const PERSONA_ID = '62000000-0000-4000-8000-000000000001';
const RENAMED_PERSONA = '62000000-0000-4000-8000-000000000002';
const RELEASE_ID = '63000000-0000-4000-8000-000000000001';
const FIRST_TRACK = '64000000-0000-4000-8000-000000000001';
const SECOND_TRACK = '64000000-0000-4000-8000-000000000002';
const THIRD_TRACK = '64000000-0000-4000-8000-000000000003';
const REKEYED_TRACK = '64000000-0000-4000-8000-000000000009';
const PLAYLIST_ID = '65000000-0000-4000-8000-000000000001';
const FIRST_ENTRY = '66000000-0000-4000-8000-000000000001';
const SECOND_ENTRY = '66000000-0000-4000-8000-000000000002';
const PUBLISHED_RELEASE = '63000000-0000-4000-8000-000000000011';
const DRAFT_RELEASE = '63000000-0000-4000-8000-000000000012';
const UNLISTED_GENRE_RELEASE = '63000000-0000-4000-8000-000000000013';

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

async function synchronizedDataSource(): Promise<DataSource> {
  const dataSource = new DataSource({
    type: 'postgres',
    url: DATABASE_URL,
    entities: [`${__dirname}/../**/*.entity.ts`],
    namingStrategy: new SnakeNamingStrategy(),
    dropSchema: true,
    synchronize: true,
  });
  await dataSource.initialize();
  return dataSource;
}

async function seedOwnerAndPersona(dataSource: DataSource): Promise<void> {
  await dataSource.getRepository(User).insert({
    id: OWNER_USER,
    googleId: `google-${OWNER_USER}`,
    email: `${OWNER_USER}@example.test`,
    status: UserStatus.Active,
  });
  await dataSource.getRepository(Subprofile).insert({
    id: PERSONA_ID,
    userId: OWNER_USER,
    slug: 'night-shift',
    displayName: 'Night Shift',
    kind: SubprofileKind.Dj,
  });
}

describeWithDatabase('AddStudioPlaylists1831500000000 on real Postgres', () => {
  let dataSource: DataSource;
  let queryRunner: QueryRunner;

  const entryRows = async (): Promise<
    { id: string; track_id: string | null; position: number }[]
  > =>
    dataSource.query(
      `SELECT "id", "track_id", "position" FROM "studio_playlist_tracks"
        WHERE "playlist_id" = $1 ORDER BY "position"`,
      [PLAYLIST_ID],
    );

  const playlistRow = async (): Promise<
    {
      credit_subprofile_id: string | null;
      is_credited_to_persona: boolean;
    }[]
  > =>
    dataSource.query(
      `SELECT "credit_subprofile_id", "is_credited_to_persona"
         FROM "studio_playlists" WHERE "id" = $1`,
      [PLAYLIST_ID],
    );

  beforeAll(async () => {
    refuseUnlessTestDatabase(DATABASE_URL!);
    dataSource = await synchronizedDataSource();
    // The two tables come from the migration under review, so drop what
    // `synchronize` built from the entities and let the migration create them.
    await dataSource.query(
      `DROP TABLE "studio_playlist_tracks", "studio_playlists"`,
    );
    await dataSource.query(`DROP TYPE "studio_playlists_visibility_enum"`);
    queryRunner = dataSource.createQueryRunner();
    await new AddStudioPlaylists1831500000000().up(queryRunner);

    await seedOwnerAndPersona(dataSource);
    await dataSource.query(
      `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type")
       VALUES ($1, $2, 'Lisbon at four', 'mix')`,
      [RELEASE_ID, PERSONA_ID],
    );
    await dataSource.query(
      `INSERT INTO "studio_tracks" ("id", "release_id", "position", "title")
       VALUES ($1, $4, 1, 'Opening'), ($2, $4, 2, 'Middle'), ($3, $4, 3, 'Closing')`,
      [FIRST_TRACK, SECOND_TRACK, THIRD_TRACK, RELEASE_ID],
    );
    await dataSource.query(
      `INSERT INTO "studio_playlists"
         ("id", "user_id", "name", "visibility", "credit_subprofile_id", "is_credited_to_persona")
       VALUES ($1, $2, 'Night bus', 'public', $3, true)`,
      [PLAYLIST_ID, OWNER_USER, PERSONA_ID],
    );
    await dataSource.query(
      `INSERT INTO "studio_playlist_tracks" ("id", "playlist_id", "track_id", "position")
       VALUES ($1, $3, $4, 1), ($2, $3, $5, 2)`,
      [FIRST_ENTRY, SECOND_ENTRY, PLAYLIST_ID, FIRST_TRACK, SECOND_TRACK],
    );
  }, 120000);

  afterAll(async () => {
    await queryRunner?.release();
    await dataSource?.destroy();
  });

  it('defaults a new playlist to private with no persona credit', async () => {
    const rows: { visibility: string; is_credited_to_persona: boolean }[] =
      await dataSource.query(
        `INSERT INTO "studio_playlists" ("user_id", "name") VALUES ($1, 'Drafts')
         RETURNING "visibility", "is_credited_to_persona"`,
        [OWNER_USER],
      );
    expect(rows).toEqual([
      { visibility: 'private', is_credited_to_persona: false },
    ]);
  });

  it('swaps two entry positions in one statement under the deferrable constraint', async () => {
    await dataSource.query(
      `UPDATE "studio_playlist_tracks" AS "entry" SET "position" = "ordering"."position"
         FROM unnest($2::uuid[], $3::smallint[]) AS "ordering"("entry_id", "position")
        WHERE "entry"."id" = "ordering"."entry_id" AND "entry"."playlist_id" = $1`,
      [PLAYLIST_ID, [FIRST_ENTRY, SECOND_ENTRY], [2, 1]],
    );
    expect((await entryRows()).map((row) => row.id)).toEqual([
      SECOND_ENTRY,
      FIRST_ENTRY,
    ]);
  });

  it('refuses two entries at one position once the statement ends', async () => {
    await expect(
      dataSource.query(
        `UPDATE "studio_playlist_tracks" SET "position" = 1 WHERE "playlist_id" = $1`,
        [PLAYLIST_ID],
      ),
    ).rejects.toThrow(/UQ_studio_playlist_tracks_playlist_position/);
  });

  it('refuses the same track twice in one playlist', async () => {
    await expect(
      dataSource.query(
        `INSERT INTO "studio_playlist_tracks" ("playlist_id", "track_id", "position")
         VALUES ($1, $2, 3)`,
        [PLAYLIST_ID, FIRST_TRACK],
      ),
    ).rejects.toThrow(/UQ_studio_playlist_tracks_playlist_track/);
  });

  it('refuses a persona credit stored without the persona flag', async () => {
    await expect(
      dataSource.query(
        `INSERT INTO "studio_playlists" ("user_id", "name", "credit_subprofile_id")
         VALUES ($1, 'Sneaky', $2)`,
        [OWNER_USER, PERSONA_ID],
      ),
    ).rejects.toThrow(/CHK_studio_playlists_persona_credit/);
  });

  it('keeps an entry as an unavailable row when its track gets a fresh id', async () => {
    await dataSource.query(
      `UPDATE "studio_tracks" SET "id" = $1 WHERE "id" = $2`,
      [REKEYED_TRACK, SECOND_TRACK],
    );
    const secondEntry = (await entryRows()).find(
      (row) => row.id === SECOND_ENTRY,
    );
    expect(secondEntry?.track_id).toBeNull();
  });

  it('removes an entry along with its track', async () => {
    await dataSource.query(`DELETE FROM "studio_tracks" WHERE "id" = $1`, [
      FIRST_TRACK,
    ]);
    expect((await entryRows()).map((row) => row.id)).toEqual([SECOND_ENTRY]);
  });

  it('carries a persona credit to the fresh id an unlink issues', async () => {
    await dataSource.query(
      `UPDATE "subprofiles" SET "id" = $1 WHERE "id" = $2`,
      [RENAMED_PERSONA, PERSONA_ID],
    );
    expect(await playlistRow()).toEqual([
      { credit_subprofile_id: RENAMED_PERSONA, is_credited_to_persona: true },
    ]);
  });

  it('clears the credit and keeps the persona flag when the credited persona is deleted', async () => {
    await dataSource.query(`DELETE FROM "subprofiles" WHERE "id" = $1`, [
      RENAMED_PERSONA,
    ]);
    expect(await playlistRow()).toEqual([
      { credit_subprofile_id: null, is_credited_to_persona: true },
    ]);
  });

  it('removes playlists and their entries along with their owner', async () => {
    await dataSource.query(`DELETE FROM "users" WHERE "id" = $1`, [OWNER_USER]);
    const counts: { playlists: number; entries: number }[] =
      await dataSource.query(
        `SELECT (SELECT COUNT(*)::int FROM "studio_playlists") AS "playlists",
                (SELECT COUNT(*)::int FROM "studio_playlist_tracks") AS "entries"`,
      );
    expect(counts).toEqual([{ playlists: 0, entries: 0 }]);
  });

  it('runs down and up again', async () => {
    await new AddStudioPlaylists1831500000000().down(queryRunner);
    const remaining: { table_name: string }[] = await dataSource.query(
      `SELECT "table_name" FROM "information_schema"."tables"
        WHERE "table_name" IN ('studio_playlists', 'studio_playlist_tracks')`,
    );
    expect(remaining).toEqual([]);
    await new AddStudioPlaylists1831500000000().up(queryRunner);
  });
});

describeWithDatabase(
  'AddStudioReleaseFollowersNotifiedAt1831500100000 on real Postgres',
  () => {
    let dataSource: DataSource;
    let queryRunner: QueryRunner;

    beforeAll(async () => {
      refuseUnlessTestDatabase(DATABASE_URL!);
      dataSource = await synchronizedDataSource();
      // The column and the index come from the migration under review.
      await dataSource.query(
        `DROP INDEX IF EXISTS "IDX_studio_releases_genre_published_at"`,
      );
      await dataSource.query(
        `ALTER TABLE "studio_releases" DROP COLUMN "followers_notified_at"`,
      );
      await seedOwnerAndPersona(dataSource);
      await dataSource.query(
        `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type", "status", "published_at")
         VALUES ($1, $3, 'Out already', 'mix', 'published', '2026-10-01T09:00:00.000Z'),
                ($2, $3, 'Still drafting', 'mix', 'draft', NULL)`,
        [PUBLISHED_RELEASE, DRAFT_RELEASE, PERSONA_ID],
      );
      queryRunner = dataSource.createQueryRunner();
      await new AddStudioReleaseFollowersNotifiedAt1831500100000().up(
        queryRunner,
      );
    }, 120000);

    afterAll(async () => {
      await queryRunner?.release();
      await dataSource?.destroy();
    });

    it('marks releases already past draft as alerted and leaves drafts open', async () => {
      const rows: { id: string; followers_notified_at: Date | null }[] =
        await dataSource.query(
          `SELECT "id", "followers_notified_at" FROM "studio_releases" ORDER BY "id"`,
        );
      expect(rows).toEqual([
        {
          id: PUBLISHED_RELEASE,
          followers_notified_at: new Date('2026-10-01T09:00:00.000Z'),
        },
        { id: DRAFT_RELEASE, followers_notified_at: null },
      ]);
    });

    it('builds the genre index over published releases only', async () => {
      const rows: { indexdef: string }[] = await dataSource.query(
        `SELECT "indexdef" FROM "pg_indexes"
          WHERE "indexname" = 'IDX_studio_releases_genre_published_at'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.indexdef).toContain(
        '(genre, published_at DESC, id DESC)',
      );
      expect(rows[0]?.indexdef).toContain("WHERE (status = 'published'");
    });

    it('runs down and up again', async () => {
      await new AddStudioReleaseFollowersNotifiedAt1831500100000().down(
        queryRunner,
      );
      const columns: { column_name: string }[] = await dataSource.query(
        `SELECT "column_name" FROM "information_schema"."columns"
          WHERE "table_name" = 'studio_releases' AND "column_name" = 'followers_notified_at'`,
      );
      expect(columns).toEqual([]);
      await new AddStudioReleaseFollowersNotifiedAt1831500100000().up(
        queryRunner,
      );
    });
  },
);

describeWithDatabase(
  'AddStudioV2EnumValues1831500200000 on real Postgres',
  () => {
    let dataSource: DataSource;
    let queryRunner: QueryRunner;

    beforeAll(async () => {
      refuseUnlessTestDatabase(DATABASE_URL!);
      dataSource = new DataSource({
        type: 'postgres',
        url: DATABASE_URL,
        entities: [],
        dropSchema: true,
        synchronize: false,
      });
      await dataSource.initialize();
      // The two types as they stand before this migration, cut down to a label
      // each: the migration only appends.
      await dataSource.query(
        `CREATE TYPE "notifications_type_enum" AS ENUM ('persona_update')`,
      );
      await dataSource.query(
        `CREATE TYPE "saved_item_subject_type_enum" AS ENUM ('studio_track')`,
      );
      queryRunner = dataSource.createQueryRunner();
    }, 120000);

    afterAll(async () => {
      await queryRunner?.release();
      await dataSource?.destroy();
    });

    const labelsOf = async (typeName: string): Promise<string[]> => {
      const rows: { label: string }[] = await dataSource.query(
        `SELECT unnest(enum_range(NULL::"${typeName}"))::text AS "label"`,
      );
      return rows.map((row) => row.label);
    };

    it('runs outside the migration transaction', () => {
      expect(new AddStudioV2EnumValues1831500200000().transaction).toBe(false);
    });

    it('appends both labels, and a second run changes nothing', async () => {
      await new AddStudioV2EnumValues1831500200000().up(queryRunner);
      await new AddStudioV2EnumValues1831500200000().up(queryRunner);
      expect(await labelsOf('notifications_type_enum')).toEqual([
        'persona_update',
        'studio_release_published',
      ]);
      expect(await labelsOf('saved_item_subject_type_enum')).toEqual([
        'studio_track',
        'studio_playlist',
      ]);
    });

    it('refuses to run down', async () => {
      await expect(
        new AddStudioV2EnumValues1831500200000().down(),
      ).rejects.toThrow(/Irreversible/);
    });
  },
);

describeWithDatabase(
  'AddStudioReleaseGenres1838000200000 on real Postgres',
  () => {
    let dataSource: DataSource;
    let queryRunner: QueryRunner;

    beforeAll(async () => {
      refuseUnlessTestDatabase(DATABASE_URL!);
      dataSource = await synchronizedDataSource();
      // The schema as it stands before this migration: no `genres` column and
      // the single-genre btree index.
      await dataSource.query(
        `DROP INDEX IF EXISTS "IDX_studio_releases_genres_published"`,
      );
      await dataSource.query(
        `ALTER TABLE "studio_releases" DROP COLUMN "genres"`,
      );
      await dataSource.query(
        `CREATE INDEX "IDX_studio_releases_genre_published_at" ON "studio_releases" ("genre", "published_at" DESC, "id" DESC) WHERE "status" = 'published'`,
      );
      await seedOwnerAndPersona(dataSource);
      await dataSource.query(
        `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type", "status", "published_at", "genre")
         VALUES ($1, $4, 'Out already', 'mix', 'published', '2026-10-01T09:00:00.000Z', 'fado'),
                ($2, $4, 'Still drafting', 'mix', 'draft', NULL, NULL),
                ($3, $4, 'Old genre', 'mix', 'published', '2026-10-02T09:00:00.000Z', 'polka')`,
        [PUBLISHED_RELEASE, DRAFT_RELEASE, UNLISTED_GENRE_RELEASE, PERSONA_ID],
      );
      queryRunner = dataSource.createQueryRunner();
      await new AddStudioReleaseGenres1838000200000().up(queryRunner);
    }, 120000);

    afterAll(async () => {
      await queryRunner?.release();
      await dataSource?.destroy();
    });

    it('backfills genres from genre, copying an unlisted value as stored', async () => {
      const rows: { id: string; genre: string | null; genres: string[] }[] =
        await dataSource.query(
          `SELECT "id", "genre", "genres" FROM "studio_releases" ORDER BY "id"`,
        );
      expect(rows).toEqual([
        { id: PUBLISHED_RELEASE, genre: 'fado', genres: ['fado'] },
        { id: DRAFT_RELEASE, genre: null, genres: [] },
        { id: UNLISTED_GENRE_RELEASE, genre: 'polka', genres: ['polka'] },
      ]);
    });

    it('swaps the btree index for a GIN index over published releases only', async () => {
      const rows: { indexname: string; indexdef: string }[] =
        await dataSource.query(
          `SELECT "indexname", "indexdef" FROM "pg_indexes"
            WHERE "tablename" = 'studio_releases' AND "indexname" LIKE 'IDX_studio_releases_genre%'
            ORDER BY "indexname"`,
        );
      expect(rows.map((row) => row.indexname)).toEqual([
        'IDX_studio_releases_genres_published',
      ]);
      expect(rows[0]?.indexdef).toContain('USING gin (genres)');
      expect(rows[0]?.indexdef).toContain("WHERE (status = 'published'");
    });

    it('runs down and up again', async () => {
      await new AddStudioReleaseGenres1838000200000().down(queryRunner);
      const columns: { column_name: string }[] = await dataSource.query(
        `SELECT "column_name" FROM "information_schema"."columns"
          WHERE "table_name" = 'studio_releases' AND "column_name" = 'genres'`,
      );
      expect(columns).toEqual([]);
      const indexNames: { indexname: string }[] = await dataSource.query(
        `SELECT "indexname" FROM "pg_indexes"
          WHERE "tablename" = 'studio_releases' AND "indexname" LIKE 'IDX_studio_releases_genre%'`,
      );
      expect(indexNames).toEqual([
        { indexname: 'IDX_studio_releases_genre_published_at' },
      ]);
      await new AddStudioReleaseGenres1838000200000().up(queryRunner);
    });
  },
);
