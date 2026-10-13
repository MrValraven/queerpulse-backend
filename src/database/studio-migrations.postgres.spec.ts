// Lives in `src/database`, outside `src/migrations`: the TypeORM CLI and
// `DatabaseModule` require every `src/migrations/*.ts` file.
import { DataSource, QueryRunner } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { AddStudio1830900000000 } from '../migrations/1830900000000-AddStudio';
import { AddStudioReportAndSavedKinds1830900100000 } from '../migrations/1830900100000-AddStudioReportAndSavedKinds';
import {
  Subprofile,
  SubprofileKind,
} from '../subprofiles/entities/subprofile.entity';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * Studio v1 migrations on real Postgres. Skipped unless
 * `STUDIO_MIGRATIONS_DATABASE_URL` names a database whose name ends in
 * `_test` (it drops and synchronizes the schema). Run it with, for example:
 *
 *   STUDIO_MIGRATIONS_DATABASE_URL=postgres://postgres@127.0.0.1:55450/studio_test \
 *     npx jest src/database/studio-migrations.postgres.spec.ts
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const ARTIST_USER = '51000000-0000-4000-8000-000000000001';
const STAFF_USER = '51000000-0000-4000-8000-000000000002';
const ARTIST_PERSONA = '52000000-0000-4000-8000-000000000001';
const RENAMED_PERSONA = '52000000-0000-4000-8000-000000000002';
const RELEASE_ID = '53000000-0000-4000-8000-000000000001';
const FIRST_TRACK = '54000000-0000-4000-8000-000000000001';
const SECOND_TRACK = '54000000-0000-4000-8000-000000000002';
const AUDIO_KEY =
  'studio-audio/55000000-0000-4000-8000-000000000001/55000000-0000-4000-8000-000000000002.mp3';

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

describeWithDatabase('AddStudio1830900000000 on real Postgres', () => {
  let dataSource: DataSource;
  let queryRunner: QueryRunner;

  const trackPositions = async (): Promise<Record<string, number>> => {
    const rows: { id: string; position: number }[] = await dataSource.query(
      `SELECT "id", "position" FROM "studio_tracks" WHERE "release_id" = $1`,
      [RELEASE_ID],
    );
    return Object.fromEntries(rows.map((row) => [row.id, row.position]));
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
    // The tables come from the migration under review, so drop what
    // `synchronize` built from the entities and let the migration create them.
    await dataSource.query(
      `DROP TABLE "studio_audio_uploads", "studio_tracks", "studio_releases", "studio_access_grants"`,
    );
    await dataSource.query(
      `DROP TYPE "studio_releases_type_enum", "studio_releases_status_enum"`,
    );
    queryRunner = dataSource.createQueryRunner();
    await new AddStudio1830900000000().up(queryRunner);

    await dataSource.getRepository(User).insert(
      [ARTIST_USER, STAFF_USER].map((userId) => ({
        id: userId,
        googleId: `google-${userId}`,
        email: `${userId}@example.test`,
        status: UserStatus.Active,
      })),
    );
    await dataSource.getRepository(Subprofile).insert({
      id: ARTIST_PERSONA,
      userId: ARTIST_USER,
      slug: 'night-shift',
      displayName: 'Night Shift',
      kind: SubprofileKind.Dj,
    });
    await dataSource.query(
      `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type")
       VALUES ($1, $2, 'Lisbon at four', 'mix')`,
      [RELEASE_ID, ARTIST_PERSONA],
    );
    await dataSource.query(
      `INSERT INTO "studio_tracks" ("id", "release_id", "position", "title", "audio_key")
       VALUES ($1, $3, 1, 'Opening', $4), ($2, $3, 2, 'Closing', NULL)`,
      [FIRST_TRACK, SECOND_TRACK, RELEASE_ID, AUDIO_KEY],
    );
    await dataSource.query(
      `INSERT INTO "studio_audio_uploads" ("storage_key", "subprofile_id", "uploaded_by_id")
       VALUES ($1, $2, $3)`,
      [AUDIO_KEY, ARTIST_PERSONA, ARTIST_USER],
    );
  }, 120000);

  afterAll(async () => {
    await queryRunner?.release();
    await dataSource?.destroy();
  });

  it('swaps two positions in one statement under the deferrable constraint', async () => {
    await dataSource.query(
      `UPDATE "studio_tracks" AS "track" SET "position" = "ordering"."position"
         FROM unnest($2::uuid[], $3::smallint[]) AS "ordering"("track_id", "position")
        WHERE "track"."id" = "ordering"."track_id" AND "track"."release_id" = $1`,
      [RELEASE_ID, [FIRST_TRACK, SECOND_TRACK], [2, 1]],
    );
    expect(await trackPositions()).toEqual({
      [FIRST_TRACK]: 2,
      [SECOND_TRACK]: 1,
    });
  });

  it('refuses two tracks at one position once the statement ends', async () => {
    await expect(
      dataSource.query(
        `UPDATE "studio_tracks" SET "position" = 1 WHERE "release_id" = $1`,
        [RELEASE_ID],
      ),
    ).rejects.toThrow(/UQ_studio_tracks_release_position/);
  });

  it('refuses a second track holding the same audio key', async () => {
    await expect(
      dataSource.query(
        `UPDATE "studio_tracks" SET "audio_key" = $2 WHERE "id" = $1`,
        [SECOND_TRACK, AUDIO_KEY],
      ),
    ).rejects.toThrow(/UQ_studio_tracks_audio_key/);
  });

  it('refuses a published release with no published_at', async () => {
    await expect(
      dataSource.query(
        `UPDATE "studio_releases" SET "status" = 'published' WHERE "id" = $1`,
        [RELEASE_ID],
      ),
    ).rejects.toThrow(/CHK_studio_releases_published_at/);
  });

  it('keeps one grant per member', async () => {
    await dataSource.query(
      `INSERT INTO "studio_access_grants" ("user_id", "granted_by_id") VALUES ($1, $2)`,
      [ARTIST_USER, STAFF_USER],
    );
    await expect(
      dataSource.query(
        `INSERT INTO "studio_access_grants" ("user_id") VALUES ($1)`,
        [ARTIST_USER],
      ),
    ).rejects.toThrow(/UQ_studio_access_grants_user_id/);
  });

  it('nulls the granting staff account when it is erased', async () => {
    await dataSource.query(`DELETE FROM "users" WHERE "id" = $1`, [STAFF_USER]);
    const rows: { granted_by_id: string | null }[] = await dataSource.query(
      `SELECT "granted_by_id" FROM "studio_access_grants" WHERE "user_id" = $1`,
      [ARTIST_USER],
    );
    expect(rows).toEqual([{ granted_by_id: null }]);
  });

  it('carries releases and audio uploads to the fresh persona id an unlink issues', async () => {
    await dataSource.query(
      `UPDATE "subprofiles" SET "id" = $1 WHERE "id" = $2`,
      [RENAMED_PERSONA, ARTIST_PERSONA],
    );
    const releaseRows: { subprofile_id: string }[] = await dataSource.query(
      `SELECT "subprofile_id" FROM "studio_releases" WHERE "id" = $1`,
      [RELEASE_ID],
    );
    const uploadRows: { subprofile_id: string }[] = await dataSource.query(
      `SELECT "subprofile_id" FROM "studio_audio_uploads" WHERE "storage_key" = $1`,
      [AUDIO_KEY],
    );
    expect(releaseRows).toEqual([{ subprofile_id: RENAMED_PERSONA }]);
    expect(uploadRows).toEqual([{ subprofile_id: RENAMED_PERSONA }]);
  });

  it('takes releases, tracks and audio uploads along with a deleted persona', async () => {
    await dataSource.query(`DELETE FROM "subprofiles" WHERE "id" = $1`, [
      RENAMED_PERSONA,
    ]);
    const counts: { releases: number; tracks: number; uploads: number }[] =
      await dataSource.query(
        `SELECT (SELECT COUNT(*)::int FROM "studio_releases") AS "releases",
                (SELECT COUNT(*)::int FROM "studio_tracks") AS "tracks",
                (SELECT COUNT(*)::int FROM "studio_audio_uploads") AS "uploads"`,
      );
    expect(counts).toEqual([{ releases: 0, tracks: 0, uploads: 0 }]);
  });

  it('runs down and up again', async () => {
    await new AddStudio1830900000000().down(queryRunner);
    const remaining: { table_name: string }[] = await dataSource.query(
      `SELECT "table_name" FROM "information_schema"."tables" WHERE "table_name" LIKE 'studio_%'`,
    );
    expect(remaining).toEqual([]);
    await new AddStudio1830900000000().up(queryRunner);
  });
});

describeWithDatabase(
  'AddStudioReportAndSavedKinds1830900100000 on real Postgres',
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
      // The two types as they stand before this migration, cut down to a
      // label each: the migration only appends.
      await dataSource.query(
        `CREATE TYPE "reports_subject_type_enum" AS ENUM ('member')`,
      );
      await dataSource.query(
        `CREATE TYPE "saved_item_subject_type_enum" AS ENUM ('listing')`,
      );
      queryRunner = dataSource.createQueryRunner();
    }, 120000);

    afterAll(async () => {
      await queryRunner?.release();
      await dataSource?.destroy();
    });

    it('appends the labels inside the migration transaction', async () => {
      await queryRunner.startTransaction();
      await new AddStudioReportAndSavedKinds1830900100000().up(queryRunner);
      await queryRunner.commitTransaction();

      const reportLabels: { label: string }[] = await dataSource.query(
        `SELECT unnest(enum_range(NULL::"reports_subject_type_enum"))::text AS "label"`,
      );
      const savedLabels: { label: string }[] = await dataSource.query(
        `SELECT unnest(enum_range(NULL::"saved_item_subject_type_enum"))::text AS "label"`,
      );
      expect(reportLabels.map((row) => row.label)).toEqual([
        'member',
        'studio_release',
      ]);
      expect(savedLabels.map((row) => row.label)).toEqual([
        'listing',
        'studio_release',
        'studio_track',
      ]);
    });

    it('refuses to run down', async () => {
      await expect(
        new AddStudioReportAndSavedKinds1830900100000().down(),
      ).rejects.toThrow(/Irreversible/);
    });
  },
);
