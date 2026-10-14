// Lives in `src/database`, outside `src/migrations`: the TypeORM CLI and
// `DatabaseModule` require every `src/migrations/*.ts` file.
import { DataSource, QueryRunner } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { AddStudioArtistKindEnumValues1833000000000 } from '../migrations/1833000000000-AddStudioArtistKindEnumValues';
import { AddStudioTrackEpisodeColumns1833000100000 } from '../migrations/1833000100000-AddStudioTrackEpisodeColumns';
import {
  Subprofile,
  SubprofileKind,
} from '../subprofiles/entities/subprofile.entity';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * Studio artist kinds migrations on real Postgres. Skipped unless
 * `STUDIO_MIGRATIONS_DATABASE_URL` names a database whose name ends in
 * `_test` (it drops and synchronizes the schema). Run it with, for example:
 *
 *   STUDIO_MIGRATIONS_DATABASE_URL=postgres://postgres@127.0.0.1:55450/studio_test \
 *     npx jest src/database/studio-artist-kinds-migrations.postgres.spec.ts
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const OWNER_USER = 'e5000000-0000-4000-8000-000000000001';
const PERSONA_ID = 'e5100000-0000-4000-8000-000000000001';
const SHOW_ID = 'e5200000-0000-4000-8000-000000000001';
const EPISODE_ID = 'e5300000-0000-4000-8000-000000000001';

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

describeWithDatabase(
  'AddStudioArtistKindEnumValues1833000000000 on real Postgres',
  () => {
    let dataSource: DataSource;
    let queryRunner: QueryRunner;

    const labelsOf = async (typeName: string): Promise<string[]> => {
      const rows: { label: string }[] = await dataSource.query(
        `SELECT unnest(enum_range(NULL::"${typeName}"))::text AS "label"`,
      );
      return rows.map((row) => row.label);
    };

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
      // The two types as they stand before this migration, cut down to the
      // labels that matter: the migration only appends.
      await dataSource.query(
        `CREATE TYPE "studio_releases_type_enum" AS ENUM ('album', 'ep', 'single', 'mix')`,
      );
      await dataSource.query(
        `CREATE TYPE "notifications_type_enum" AS ENUM ('studio_release_published')`,
      );
      queryRunner = dataSource.createQueryRunner();
    }, 120000);

    afterAll(async () => {
      await queryRunner?.release();
      await dataSource?.destroy();
    });

    it('runs outside the migration transaction', () => {
      expect(new AddStudioArtistKindEnumValues1833000000000().transaction).toBe(
        false,
      );
    });

    it('appends the three release types and the episode notification, and a second run changes nothing', async () => {
      await new AddStudioArtistKindEnumValues1833000000000().up(queryRunner);
      await new AddStudioArtistKindEnumValues1833000000000().up(queryRunner);
      expect(await labelsOf('studio_releases_type_enum')).toEqual([
        'album',
        'ep',
        'single',
        'mix',
        'podcast',
        'edit',
        'lip_sync',
      ]);
      expect(await labelsOf('notifications_type_enum')).toEqual([
        'studio_release_published',
        'studio_episode_published',
      ]);
    });

    it('refuses to run down', async () => {
      await expect(
        new AddStudioArtistKindEnumValues1833000000000().down(),
      ).rejects.toThrow(/Irreversible/);
    });
  },
);

describeWithDatabase(
  'AddStudioTrackEpisodeColumns1833000100000 on real Postgres',
  () => {
    let dataSource: DataSource;
    let queryRunner: QueryRunner;

    const indexDefinition = async (indexName: string): Promise<string> => {
      const rows: { indexdef: string }[] = await dataSource.query(
        `SELECT "indexdef" FROM "pg_indexes" WHERE "indexname" = $1`,
        [indexName],
      );
      return rows[0]?.indexdef ?? '';
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
      // Everything this migration adds comes from the migration under
      // review, so drop what `synchronize` built from the entity first.
      await dataSource.query(
        `ALTER TABLE "studio_tracks" DROP CONSTRAINT IF EXISTS "CHK_studio_tracks_sources"`,
      );
      await dataSource.query(
        `ALTER TABLE "studio_tracks" DROP CONSTRAINT IF EXISTS "CHK_studio_tracks_notes"`,
      );
      await dataSource.query(
        `DROP INDEX IF EXISTS "IDX_studio_tracks_release_published_at"`,
      );
      await dataSource.query(
        `DROP INDEX IF EXISTS "IDX_studio_tracks_published_at"`,
      );
      await dataSource.query(
        `ALTER TABLE "studio_tracks"
           DROP COLUMN "notes",
           DROP COLUMN "sources",
           DROP COLUMN "published_at",
           DROP COLUMN "followers_notified_at"`,
      );
      queryRunner = dataSource.createQueryRunner();
      await new AddStudioTrackEpisodeColumns1833000100000().up(queryRunner);

      await dataSource.getRepository(User).insert({
        id: OWNER_USER,
        googleId: `google-${OWNER_USER}`,
        email: `${OWNER_USER}@example.test`,
        status: UserStatus.Active,
      });
      await dataSource.getRepository(Subprofile).insert({
        id: PERSONA_ID,
        userId: OWNER_USER,
        slug: 'lisbon-after-dark',
        displayName: 'Lisbon After Dark',
        kind: SubprofileKind.Podcaster,
      });
      await dataSource.query(
        `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type")
         VALUES ($1, $2, 'Lisbon After Dark', 'podcast')`,
        [SHOW_ID, PERSONA_ID],
      );
      await dataSource.query(
        `INSERT INTO "studio_tracks" ("id", "release_id", "position", "title")
         VALUES ($1, $2, 1, 'Housing in Lisbon')`,
        [EPISODE_ID, SHOW_ID],
      );
    }, 120000);

    afterAll(async () => {
      await queryRunner?.release();
      await dataSource?.destroy();
    });

    it('starts an existing track with no notes, no sources and no publish time', async () => {
      const rows: {
        notes: string | null;
        sources: unknown[];
        published_at: Date | null;
        followers_notified_at: Date | null;
      }[] = await dataSource.query(
        `SELECT "notes", "sources", "published_at", "followers_notified_at"
           FROM "studio_tracks" WHERE "id" = $1`,
        [EPISODE_ID],
      );
      expect(rows).toEqual([
        {
          notes: null,
          sources: [],
          published_at: null,
          followers_notified_at: null,
        },
      ]);
    });

    it('refuses sources that are not a list and a list of 101 sources', async () => {
      await expect(
        dataSource.query(
          `UPDATE "studio_tracks" SET "sources" = '{"title": "x"}'::jsonb WHERE "id" = $1`,
          [EPISODE_ID],
        ),
      ).rejects.toThrow(/CHK_studio_tracks_sources/);
      const tooMany = JSON.stringify(
        Array.from({ length: 101 }, (_unused, index) => ({
          title: `Song ${index}`,
          artist: 'Ana Moura',
        })),
      );
      await expect(
        dataSource.query(
          `UPDATE "studio_tracks" SET "sources" = $2::jsonb WHERE "id" = $1`,
          [EPISODE_ID, tooMany],
        ),
      ).rejects.toThrow(/CHK_studio_tracks_sources/);
    });

    it('refuses show notes over 4000 characters', async () => {
      await expect(
        dataSource.query(
          `UPDATE "studio_tracks" SET "notes" = $2 WHERE "id" = $1`,
          [EPISODE_ID, 'n'.repeat(4001)],
        ),
      ).rejects.toThrow(/CHK_studio_tracks_notes/);
      await dataSource.query(
        `UPDATE "studio_tracks" SET "notes" = $2 WHERE "id" = $1`,
        [EPISODE_ID, 'n'.repeat(4000)],
      );
    });

    it('keeps the publish time to the millisecond', async () => {
      await dataSource.query(
        `UPDATE "studio_tracks" SET "published_at" = '2026-10-14T09:00:00.123456Z' WHERE "id" = $1`,
        [EPISODE_ID],
      );
      const rows: { is_milliseconds: boolean }[] = await dataSource.query(
        `SELECT "published_at" = '2026-10-14T09:00:00.123Z'::timestamptz AS "is_milliseconds"
           FROM "studio_tracks" WHERE "id" = $1`,
        [EPISODE_ID],
      );
      expect(rows).toEqual([{ is_milliseconds: true }]);
    });

    it('builds both episode indexes over published episodes only, newest first', async () => {
      const perShow = await indexDefinition(
        'IDX_studio_tracks_release_published_at',
      );
      expect(perShow).toContain('(release_id, published_at DESC)');
      expect(perShow).toContain('WHERE (published_at IS NOT NULL)');
      const acrossShows = await indexDefinition(
        'IDX_studio_tracks_published_at',
      );
      expect(acrossShows).toContain('(published_at DESC, id DESC)');
      expect(acrossShows).toContain('WHERE (published_at IS NOT NULL)');
    });

    it('runs down and up again', async () => {
      await new AddStudioTrackEpisodeColumns1833000100000().down(queryRunner);
      const columns: { column_name: string }[] = await dataSource.query(
        `SELECT "column_name" FROM "information_schema"."columns"
          WHERE "table_name" = 'studio_tracks'
            AND "column_name" IN ('notes', 'sources', 'published_at', 'followers_notified_at')`,
      );
      expect(columns).toEqual([]);
      await new AddStudioTrackEpisodeColumns1833000100000().up(queryRunner);
    });
  },
);
