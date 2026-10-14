// Lives in `src/database`, outside `src/migrations`: the TypeORM CLI and
// `DatabaseModule` require every `src/migrations/*.ts` file.
import { DataSource, QueryRunner } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { AddStudioArtistToolsEnumValues1832000000000 } from '../migrations/1832000000000-AddStudioArtistToolsEnumValues';
import { AddStudioArtistTools1832000100000 } from '../migrations/1832000100000-AddStudioArtistTools';
import {
  Subprofile,
  SubprofileKind,
} from '../subprofiles/entities/subprofile.entity';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * Studio v3 migrations on real Postgres. Skipped unless
 * `STUDIO_MIGRATIONS_DATABASE_URL` names a database whose name ends in
 * `_test` (it drops and synchronizes the schema). Run it with, for example:
 *
 *   STUDIO_MIGRATIONS_DATABASE_URL=postgres://postgres@127.0.0.1:55450/studio_test \
 *     npx jest src/database/studio-v3-migrations.postgres.spec.ts
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const OWNER_USER = 'b1000000-0000-4000-8000-000000000001';
const LISTENER_USER = 'b1000000-0000-4000-8000-000000000002';
const PERSONA_ID = 'b2000000-0000-4000-8000-000000000001';
const RENAMED_PERSONA = 'b2000000-0000-4000-8000-000000000002';
const RELEASE_ID = 'b3000000-0000-4000-8000-000000000001';
const OTHER_RELEASE = 'b3000000-0000-4000-8000-000000000002';
const REKEYED_RELEASE = 'b3000000-0000-4000-8000-000000000009';
const POST_ID = 'b4000000-0000-4000-8000-000000000001';
const PREVIEW_TOKEN = 'a'.repeat(64);

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

describeWithDatabase(
  'AddStudioArtistToolsEnumValues1832000000000 on real Postgres',
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
      // The three types as they stand before this migration, cut down to
      // the labels that matter: the migration only adds.
      await dataSource.query(
        `CREATE TYPE "studio_releases_status_enum" AS ENUM ('draft', 'published', 'taken_down')`,
      );
      await dataSource.query(
        `CREATE TYPE "notifications_type_enum" AS ENUM ('studio_release_published')`,
      );
      await dataSource.query(
        `CREATE TYPE "reports_subject_type_enum" AS ENUM ('studio_release')`,
      );
      queryRunner = dataSource.createQueryRunner();
    }, 120000);

    afterAll(async () => {
      await queryRunner?.release();
      await dataSource?.destroy();
    });

    it('runs outside the migration transaction', () => {
      expect(
        new AddStudioArtistToolsEnumValues1832000000000().transaction,
      ).toBe(false);
    });

    it('adds scheduled before published and the two persona post labels, and a second run changes nothing', async () => {
      await new AddStudioArtistToolsEnumValues1832000000000().up(queryRunner);
      await new AddStudioArtistToolsEnumValues1832000000000().up(queryRunner);
      expect(await labelsOf('studio_releases_status_enum')).toEqual([
        'draft',
        'scheduled',
        'published',
        'taken_down',
      ]);
      expect(await labelsOf('notifications_type_enum')).toEqual([
        'studio_release_published',
        'persona_post',
      ]);
      expect(await labelsOf('reports_subject_type_enum')).toEqual([
        'studio_release',
        'persona_post',
      ]);
    });

    it('refuses to run down', async () => {
      await expect(
        new AddStudioArtistToolsEnumValues1832000000000().down(),
      ).rejects.toThrow(/Irreversible/);
    });
  },
);

describeWithDatabase(
  'AddStudioArtistTools1832000100000 on real Postgres',
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

    const countOf = async (table: string): Promise<number> => {
      const rows: { total: number }[] = await dataSource.query(
        `SELECT COUNT(*)::int AS "total" FROM "${table}"`,
      );
      return rows[0]?.total ?? 0;
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
      // Everything this migration adds comes from the migration under review,
      // so drop what `synchronize` built from the entities first.
      await dataSource.query(
        `DROP TABLE "subprofile_post_quota_entries", "subprofile_posts", "studio_press_kits", "studio_release_versions", "studio_release_reminders"`,
      );
      await dataSource.query(
        `ALTER TABLE "studio_releases" DROP CONSTRAINT IF EXISTS "CHK_studio_releases_publish_at"`,
      );
      await dataSource.query(
        `DROP INDEX IF EXISTS "IDX_studio_releases_publish_at"`,
      );
      await dataSource.query(
        `DROP INDEX IF EXISTS "UQ_studio_releases_preview_token"`,
      );
      await dataSource.query(
        `ALTER TABLE "studio_releases"
         DROP COLUMN "publish_at",
         DROP COLUMN "tracks_changed_at",
         DROP COLUMN "preview_token",
         DROP COLUMN "preview_link_created_at",
         DROP COLUMN "buy_url"`,
      );
      queryRunner = dataSource.createQueryRunner();
      await new AddStudioArtistTools1832000100000().up(queryRunner);

      await dataSource.getRepository(User).insert(
        [OWNER_USER, LISTENER_USER].map((userId) => ({
          id: userId,
          googleId: `google-${userId}`,
          email: `${userId}@example.test`,
          status: UserStatus.Active,
        })),
      );
      await dataSource.getRepository(Subprofile).insert({
        id: PERSONA_ID,
        userId: OWNER_USER,
        slug: 'night-shift',
        displayName: 'Night Shift',
        kind: SubprofileKind.Dj,
      });
      await dataSource.query(
        `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type")
       VALUES ($1, $3, 'Lisbon at four', 'mix'), ($2, $3, 'Second', 'mix')`,
        [RELEASE_ID, OTHER_RELEASE, PERSONA_ID],
      );
    }, 120000);

    afterAll(async () => {
      await queryRunner?.release();
      await dataSource?.destroy();
    });

    it('refuses a scheduled release with no publish time', async () => {
      await expect(
        dataSource.query(
          `UPDATE "studio_releases" SET "status" = 'scheduled' WHERE "id" = $1`,
          [RELEASE_ID],
        ),
      ).rejects.toThrow(/CHK_studio_releases_publish_at/);
    });

    it('refuses a publish time on a release that is not scheduled', async () => {
      await expect(
        dataSource.query(
          `UPDATE "studio_releases" SET "publish_at" = now() WHERE "id" = $1`,
          [RELEASE_ID],
        ),
      ).rejects.toThrow(/CHK_studio_releases_publish_at/);
    });

    it('builds the drop index over scheduled releases only', async () => {
      const definition = await indexDefinition(
        'IDX_studio_releases_publish_at',
      );
      expect(definition).toContain('(publish_at)');
      expect(definition).toContain("WHERE (status = 'scheduled'");
    });

    it('refuses one preview token on two releases', async () => {
      await dataSource.query(
        `UPDATE "studio_releases" SET "preview_token" = $2 WHERE "id" = $1`,
        [RELEASE_ID, PREVIEW_TOKEN],
      );
      await expect(
        dataSource.query(
          `UPDATE "studio_releases" SET "preview_token" = $2 WHERE "id" = $1`,
          [OTHER_RELEASE, PREVIEW_TOKEN],
        ),
      ).rejects.toThrow(/UQ_studio_releases_preview_token/);
    });

    it('keeps one reminder per member and release', async () => {
      await dataSource.query(
        `INSERT INTO "studio_release_reminders" ("release_id", "user_id") VALUES ($1, $2)`,
        [RELEASE_ID, LISTENER_USER],
      );
      await expect(
        dataSource.query(
          `INSERT INTO "studio_release_reminders" ("release_id", "user_id") VALUES ($1, $2)`,
          [RELEASE_ID, LISTENER_USER],
        ),
      ).rejects.toThrow(/PK_studio_release_reminders/);
    });

    it('refuses version 1, a blank note and a repeated version', async () => {
      await expect(
        dataSource.query(
          `INSERT INTO "studio_release_versions" ("release_id", "version", "note") VALUES ($1, 1, 'First')`,
          [RELEASE_ID],
        ),
      ).rejects.toThrow(/CHK_studio_release_versions_version/);
      await expect(
        dataSource.query(
          `INSERT INTO "studio_release_versions" ("release_id", "version", "note") VALUES ($1, 2, '   ')`,
          [RELEASE_ID],
        ),
      ).rejects.toThrow(/CHK_studio_release_versions_note/);
      await dataSource.query(
        `INSERT INTO "studio_release_versions" ("release_id", "version", "note") VALUES ($1, 2, 'Remastered')`,
        [RELEASE_ID],
      );
      await expect(
        dataSource.query(
          `INSERT INTO "studio_release_versions" ("release_id", "version", "note") VALUES ($1, 2, 'Again')`,
          [RELEASE_ID],
        ),
      ).rejects.toThrow(/UQ_studio_release_versions_release_version/);
    });

    it('carries reminders and versions to the fresh id an unlink gives a release', async () => {
      await dataSource.query(
        `UPDATE "studio_releases" SET "id" = $1 WHERE "id" = $2`,
        [REKEYED_RELEASE, RELEASE_ID],
      );
      const reminders: { release_id: string }[] = await dataSource.query(
        `SELECT "release_id" FROM "studio_release_reminders"`,
      );
      const versions: { release_id: string }[] = await dataSource.query(
        `SELECT "release_id" FROM "studio_release_versions"`,
      );
      expect(reminders).toEqual([{ release_id: REKEYED_RELEASE }]);
      expect(versions).toEqual([{ release_id: REKEYED_RELEASE }]);
    });

    it('starts a press kit with no picks and no quotes, and refuses a sixth pick', async () => {
      const rows: { featured_track_ids: string[]; quotes: unknown[] }[] =
        await dataSource.query(
          `INSERT INTO "studio_press_kits" ("subprofile_id") VALUES ($1)
         RETURNING "featured_track_ids", "quotes"`,
          [PERSONA_ID],
        );
      expect(rows).toEqual([{ featured_track_ids: [], quotes: [] }]);
      const sixIds = Array.from(
        { length: 6 },
        (_unused, index) => `b5000000-0000-4000-8000-00000000000${index}`,
      );
      await expect(
        dataSource.query(
          `UPDATE "studio_press_kits" SET "featured_track_ids" = $2::uuid[] WHERE "subprofile_id" = $1`,
          [PERSONA_ID, sixIds],
        ),
      ).rejects.toThrow(/CHK_studio_press_kits_featured_track_ids/);
    });

    it('refuses a blank post and builds the post page index newest first', async () => {
      await expect(
        dataSource.query(
          `INSERT INTO "subprofile_posts" ("subprofile_id", "author_user_id", "body") VALUES ($1, $2, '  ')`,
          [PERSONA_ID, OWNER_USER],
        ),
      ).rejects.toThrow(/CHK_subprofile_posts_body/);
      expect(
        await indexDefinition('IDX_subprofile_posts_subprofile_created_at'),
      ).toContain('(subprofile_id, created_at DESC, id DESC)');
    });

    it('keeps a post when its author account goes, with the author cleared', async () => {
      await dataSource.query(
        `INSERT INTO "subprofile_posts" ("id", "subprofile_id", "author_user_id", "body") VALUES ($1, $2, $3, 'Out Friday')`,
        [POST_ID, PERSONA_ID, LISTENER_USER],
      );
      await dataSource.query(`DELETE FROM "users" WHERE "id" = $1`, [
        LISTENER_USER,
      ]);
      const rows: { author_user_id: string | null }[] = await dataSource.query(
        `SELECT "author_user_id" FROM "subprofile_posts" WHERE "id" = $1`,
        [POST_ID],
      );
      expect(rows).toEqual([{ author_user_id: null }]);
      // The listener's reminder went with the account.
      expect(await countOf('studio_release_reminders')).toBe(0);
    });

    it('carries posts, press kit and quota entries to a re-keyed persona', async () => {
      await dataSource.query(
        `INSERT INTO "subprofile_post_quota_entries" ("subprofile_id") VALUES ($1)`,
        [PERSONA_ID],
      );
      await dataSource.query(
        `UPDATE "subprofiles" SET "id" = $1 WHERE "id" = $2`,
        [RENAMED_PERSONA, PERSONA_ID],
      );
      const owners: { subprofile_id: string }[] = await dataSource.query(
        `SELECT "subprofile_id" FROM "subprofile_posts"
       UNION ALL SELECT "subprofile_id" FROM "studio_press_kits"
       UNION ALL SELECT "subprofile_id" FROM "subprofile_post_quota_entries"`,
      );
      expect(owners.map((row) => row.subprofile_id)).toEqual([
        RENAMED_PERSONA,
        RENAMED_PERSONA,
        RENAMED_PERSONA,
      ]);
    });

    it('removes posts, press kit, quota entries and release rows with the persona', async () => {
      await dataSource.query(`DELETE FROM "subprofiles" WHERE "id" = $1`, [
        RENAMED_PERSONA,
      ]);
      for (const table of [
        'subprofile_posts',
        'studio_press_kits',
        'subprofile_post_quota_entries',
        'studio_release_versions',
        'studio_releases',
      ]) {
        expect(await countOf(table)).toBe(0);
      }
    });

    it('runs down and up again', async () => {
      await new AddStudioArtistTools1832000100000().down(queryRunner);
      const remaining: { table_name: string }[] = await dataSource.query(
        `SELECT "table_name" FROM "information_schema"."tables"
        WHERE "table_name" IN ('studio_release_reminders', 'studio_release_versions', 'studio_press_kits', 'subprofile_posts', 'subprofile_post_quota_entries')`,
      );
      expect(remaining).toEqual([]);
      const columns: { column_name: string }[] = await dataSource.query(
        `SELECT "column_name" FROM "information_schema"."columns"
        WHERE "table_name" = 'studio_releases' AND "column_name" = 'publish_at'`,
      );
      expect(columns).toEqual([]);
      await new AddStudioArtistTools1832000100000().up(queryRunner);
    });
  },
);
