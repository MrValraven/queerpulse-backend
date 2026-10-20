// Lives in `src/database`, outside `src/migrations`: the TypeORM CLI and
// `DatabaseModule` require every `src/migrations/*.ts` file.
import { DataSource, QueryRunner } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { AddStudioPlaylistEditorNotificationTypes1833100000000 } from '../migrations/1833100000000-AddStudioPlaylistEditorNotificationTypes';
import { AddStudioPlaylistEditors1833100100000 } from '../migrations/1833100100000-AddStudioPlaylistEditors';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * Collaborative playlists migrations on real Postgres. Skipped unless
 * `STUDIO_MIGRATIONS_DATABASE_URL` names a database whose name ends in
 * `_test` (it drops and rebuilds the schema). Run it with, for example:
 *
 *   STUDIO_MIGRATIONS_DATABASE_URL=postgres://postgres@127.0.0.1:55450/studio_test \
 *     npx jest src/database/studio-playlist-editors-migrations.postgres.spec.ts
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const OWNER_USER = 'c7000000-0000-4000-8000-000000000001';
const EDITOR_USER = 'c7000000-0000-4000-8000-000000000002';
const PLAYLIST_ID = 'c7100000-0000-4000-8000-000000000001';
const ERASED_USER = 'c7000000-0000-4000-8000-000000000003';
const ENTRY_ID = 'c7200000-0000-4000-8000-000000000001';
const ADDED_BY_ENTRY_ID = 'c7200000-0000-4000-8000-000000000002';

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

describeWithDatabase(
  'AddStudioPlaylistEditorNotificationTypes1833100000000 on real Postgres',
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
      // The type as it stands before this migration, cut down to one label:
      // the migration only appends.
      await dataSource.query(
        `CREATE TYPE "notifications_type_enum" AS ENUM ('studio_episode_published')`,
      );
      queryRunner = dataSource.createQueryRunner();
    }, 120000);

    afterAll(async () => {
      await queryRunner?.release();
      await dataSource?.destroy();
    });

    it('runs outside the migration transaction', () => {
      expect(
        new AddStudioPlaylistEditorNotificationTypes1833100000000().transaction,
      ).toBe(false);
    });

    it('appends the four editor notifications, and a second run changes nothing', async () => {
      await new AddStudioPlaylistEditorNotificationTypes1833100000000().up(
        queryRunner,
      );
      await new AddStudioPlaylistEditorNotificationTypes1833100000000().up(
        queryRunner,
      );
      expect(await labelsOf('notifications_type_enum')).toEqual([
        'studio_episode_published',
        'studio_playlist_editor_invite',
        'studio_playlist_editor_invite_accepted',
        'studio_playlist_editor_invite_declined',
        'studio_playlist_editor_added',
      ]);
    });

    it('refuses to run down', async () => {
      await expect(
        new AddStudioPlaylistEditorNotificationTypes1833100000000().down(),
      ).rejects.toThrow(/Irreversible/);
    });
  },
);

describeWithDatabase(
  'AddStudioPlaylistEditors1833100100000 on real Postgres',
  () => {
    let dataSource: DataSource;
    let queryRunner: QueryRunner;

    const insertEditor = (status: string, source: string): Promise<unknown> =>
      dataSource.query(
        `INSERT INTO "studio_playlist_editors" ("playlist_id", "user_id", "invited_by_user_id", "source", "status")
         VALUES ($1, $2, $3, $4, $5)`,
        [PLAYLIST_ID, EDITOR_USER, OWNER_USER, source, status],
      );

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
      // review, so drop what `synchronize` built from the entities first.
      await dataSource.query(`DROP TABLE "studio_playlist_editors"`);
      await dataSource.query(`DROP TYPE "studio_playlist_editors_source_enum"`);
      await dataSource.query(`DROP TYPE "studio_playlist_editors_status_enum"`);
      await dataSource.query(
        `ALTER TABLE "studio_playlist_tracks" DROP COLUMN "added_by_user_id"`,
      );
      queryRunner = dataSource.createQueryRunner();

      await dataSource.getRepository(User).insert(
        [OWNER_USER, EDITOR_USER].map((userId) => ({
          id: userId,
          googleId: `google-${userId}`,
          email: `${userId}@example.test`,
          status: UserStatus.Active,
        })),
      );
      await dataSource.query(
        `INSERT INTO "studio_playlists" ("id", "user_id", "name") VALUES ($1, $2, 'Night bus')`,
        [PLAYLIST_ID, OWNER_USER],
      );
      // An entry that exists before the column migration runs.
      await dataSource.query(
        `INSERT INTO "studio_playlist_tracks" ("id", "playlist_id", "track_id", "position") VALUES ($1, $2, NULL, 1)`,
        [ENTRY_ID, PLAYLIST_ID],
      );
      await new AddStudioPlaylistEditors1833100100000().up(queryRunner);
    }, 120000);

    afterAll(async () => {
      await queryRunner?.release();
      await dataSource?.destroy();
    });

    afterEach(async () => {
      const [regclassRow]: { table_name: string | null }[] =
        await dataSource.query(
          `SELECT to_regclass('public.studio_playlist_editors') AS "table_name"`,
        );
      if (regclassRow?.table_name) {
        await dataSource.query(`DELETE FROM "studio_playlist_editors"`);
      }
    });

    it('starts every existing entry with no added by', async () => {
      const rows: { added_by_user_id: string | null }[] =
        await dataSource.query(
          `SELECT "added_by_user_id" FROM "studio_playlist_tracks" WHERE "id" = $1`,
          [ENTRY_ID],
        );
      expect(rows).toEqual([{ added_by_user_id: null }]);
    });

    it('keeps one row per member per playlist', async () => {
      await insertEditor('invited', 'member_invite');
      await expect(insertEditor('active', 'member_invite')).rejects.toThrow(
        /UQ_studio_playlist_editors_playlist_user/,
      );
    });

    it('refuses a persona co-owner row that is invited or declined', async () => {
      await expect(insertEditor('invited', 'persona_co_owner')).rejects.toThrow(
        /CHK_studio_playlist_editors_persona_source/,
      );
      await expect(
        insertEditor('declined', 'persona_co_owner'),
      ).rejects.toThrow(/CHK_studio_playlist_editors_persona_source/);
      await insertEditor('active', 'persona_co_owner');
    });

    it('indexes the editor rows by member and status', async () => {
      const rows: { indexdef: string }[] = await dataSource.query(
        `SELECT "indexdef" FROM "pg_indexes" WHERE "indexname" = 'IDX_studio_playlist_editors_user_status'`,
      );
      expect(rows[0]?.indexdef).toContain('(user_id, status)');
    });

    it('sets added by to null when the member who added the entry is erased', async () => {
      await dataSource.getRepository(User).insert({
        id: ERASED_USER,
        googleId: `google-${ERASED_USER}`,
        email: `${ERASED_USER}@example.test`,
        status: UserStatus.Active,
      });
      await dataSource.query(
        `INSERT INTO "studio_playlist_tracks" ("id", "playlist_id", "track_id", "position", "added_by_user_id") VALUES ($1, $2, NULL, 2, $3)`,
        [ADDED_BY_ENTRY_ID, PLAYLIST_ID, ERASED_USER],
      );
      await dataSource.query(
        `INSERT INTO "studio_playlist_editors" ("playlist_id", "user_id", "invited_by_user_id", "source", "status")
         VALUES ($1, $2, $3, 'member_invite', 'active')`,
        [PLAYLIST_ID, ERASED_USER, OWNER_USER],
      );
      await dataSource.query(`DELETE FROM "users" WHERE "id" = $1`, [
        ERASED_USER,
      ]);
      const entries: { added_by_user_id: string | null }[] =
        await dataSource.query(
          `SELECT "added_by_user_id" FROM "studio_playlist_tracks" WHERE "id" = $1`,
          [ADDED_BY_ENTRY_ID],
        );
      const seats: { count: number }[] = await dataSource.query(
        `SELECT COUNT(*)::int AS "count" FROM "studio_playlist_editors"`,
      );
      expect(entries).toEqual([{ added_by_user_id: null }]);
      expect(seats).toEqual([{ count: 0 }]);
    });

    it('drops everything it added on the way down', async () => {
      await new AddStudioPlaylistEditors1833100100000().down(queryRunner);
      const tables: { count: number }[] = await dataSource.query(
        `SELECT COUNT(*)::int AS "count" FROM "information_schema"."tables" WHERE "table_name" = 'studio_playlist_editors'`,
      );
      const columns: { count: number }[] = await dataSource.query(
        `SELECT COUNT(*)::int AS "count" FROM "information_schema"."columns"
          WHERE "table_name" = 'studio_playlist_tracks' AND "column_name" = 'added_by_user_id'`,
      );
      const enumTypes: { count: number }[] = await dataSource.query(
        `SELECT COUNT(*)::int AS "count" FROM "pg_type" WHERE "typname" LIKE 'studio_playlist_editors_%_enum'`,
      );
      expect(tables).toEqual([{ count: 0 }]);
      expect(columns).toEqual([{ count: 0 }]);
      expect(enumTypes).toEqual([{ count: 0 }]);
    });
  },
);
