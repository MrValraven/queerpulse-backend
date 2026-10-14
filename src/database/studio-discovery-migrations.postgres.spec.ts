// Lives in `src/database`, outside `src/migrations`: the TypeORM CLI and
// `DatabaseModule` require every `src/migrations/*.ts` file.
import { DataSource, QueryRunner } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { AddStudioCreditNotificationTypes1831800100000 } from '../migrations/1831800100000-AddStudioCreditNotificationTypes';
import { AddStudioDiscovery1831800000000 } from '../migrations/1831800000000-AddStudioDiscovery';
import {
  Subprofile,
  SubprofileKind,
} from '../subprofiles/entities/subprofile.entity';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * Studio discovery migrations on real Postgres. Skipped unless
 * `STUDIO_MIGRATIONS_DATABASE_URL` names a database whose name ends in
 * `_test` (it drops and synchronizes the schema). Run it with, for example:
 *
 *   STUDIO_MIGRATIONS_DATABASE_URL=postgres://postgres@127.0.0.1:55450/studio_test \
 *     npx jest src/database/studio-discovery-migrations.postgres.spec.ts
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const OWNER_USER = '71000000-0000-4000-8000-000000000001';
const RELEASE_PERSONA = '72000000-0000-4000-8000-000000000001';
const CREDITED_PERSONA = '72000000-0000-4000-8000-000000000002';
const RE_KEYED_PERSONA = '72000000-0000-4000-8000-000000000009';
const RELEASE_ID = '73000000-0000-4000-8000-000000000001';
const RE_KEYED_RELEASE = '73000000-0000-4000-8000-000000000009';
const TRACK_ID = '74000000-0000-4000-8000-000000000001';
const RE_KEYED_TRACK = '74000000-0000-4000-8000-000000000009';
const SCENE_ID = '75000000-0000-4000-8000-000000000001';
const FIRST_PICK = '76000000-0000-4000-8000-000000000001';
const SECOND_PICK = '76000000-0000-4000-8000-000000000002';
const SECOND_RELEASE = '73000000-0000-4000-8000-000000000002';
const CREDIT_ID = '77000000-0000-4000-8000-000000000001';

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

describeWithDatabase('AddStudioDiscovery1831800000000 on real Postgres', () => {
  let dataSource: DataSource;
  let queryRunner: QueryRunner;

  beforeAll(async () => {
    refuseUnlessTestDatabase(DATABASE_URL!);
    dataSource = await synchronizedDataSource();
    // Everything the migration under review creates comes from the
    // migration, so drop what `synchronize` built from the entities first.
    await dataSource.query(
      `DROP TABLE "studio_persona_credits", "studio_scene_events", "studio_curated_picks"`,
    );
    await dataSource.query(
      `ALTER TABLE "studio_releases" DROP COLUMN "mood", DROP COLUMN "scene_id"`,
    );
    await dataSource.query(`DROP TABLE "studio_scenes"`);
    await dataSource.query(
      `DROP TYPE "studio_persona_credits_status_enum", "studio_scenes_status_enum", "studio_curated_picks_shelf_enum"`,
    );
    queryRunner = dataSource.createQueryRunner();
    await new AddStudioDiscovery1831800000000().up(queryRunner);

    await dataSource.getRepository(User).insert({
      id: OWNER_USER,
      googleId: `google-${OWNER_USER}`,
      email: `${OWNER_USER}@example.test`,
      status: UserStatus.Active,
    });
    await dataSource.getRepository(Subprofile).insert([
      {
        id: RELEASE_PERSONA,
        userId: OWNER_USER,
        slug: 'night-shift',
        displayName: 'Night Shift',
        kind: SubprofileKind.Dj,
      },
      {
        id: CREDITED_PERSONA,
        userId: OWNER_USER,
        slug: 'river-ink',
        displayName: 'River Ink',
        kind: SubprofileKind.VisualArtist,
      },
    ]);
    await dataSource.query(
      `INSERT INTO "studio_scenes" ("id", "slug", "name", "city", "position")
       VALUES ($1, 'lisbon-ballroom', 'Lisbon ballroom', 'Lisbon', 1)`,
      [SCENE_ID],
    );
    await dataSource.query(
      `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type", "status", "published_at", "mood", "scene_id")
       VALUES ($1, $3, 'Lisbon at four', 'mix', 'published', now(), 'late-night', $4),
              ($2, $3, 'Second wind', 'mix', 'published', now(), NULL, NULL)`,
      [RELEASE_ID, SECOND_RELEASE, RELEASE_PERSONA, SCENE_ID],
    );
    await dataSource.query(
      `INSERT INTO "studio_tracks" ("id", "release_id", "position", "title")
       VALUES ($1, $2, 1, 'Opening')`,
      [TRACK_ID, RELEASE_ID],
    );
    await dataSource.query(
      `INSERT INTO "studio_persona_credits"
         ("id", "track_id", "subprofile_id", "role", "requested_by_subprofile_id", "requested_by_user_id")
       VALUES ($1, $2, $3, 'cover-art', $4, $5)`,
      [CREDIT_ID, TRACK_ID, CREDITED_PERSONA, RELEASE_PERSONA, OWNER_USER],
    );
    await dataSource.query(
      `INSERT INTO "studio_curated_picks" ("id", "shelf", "release_id", "position")
       VALUES ($1, 'staff_picks', $3, 1), ($2, 'staff_picks', $4, 2)`,
      [FIRST_PICK, SECOND_PICK, RELEASE_ID, SECOND_RELEASE],
    );
  }, 120000);

  afterAll(async () => {
    await queryRunner?.release();
    await dataSource?.destroy();
  });

  it('stores a new credit as pending', async () => {
    const [credit] = await dataSource.query(
      `SELECT "status"::text AS "status" FROM "studio_persona_credits" WHERE "id" = $1`,
      [CREDIT_ID],
    );
    expect(credit).toEqual({ status: 'pending' });
  });

  it('refuses a second credit for the same track, persona and role', async () => {
    await expect(
      dataSource.query(
        `INSERT INTO "studio_persona_credits"
           ("track_id", "subprofile_id", "role", "requested_by_subprofile_id")
         VALUES ($1, $2, 'cover-art', $3)`,
        [TRACK_ID, CREDITED_PERSONA, RELEASE_PERSONA],
      ),
    ).rejects.toThrow(/UQ_studio_persona_credits_track_subprofile_role/);
  });

  it('swaps two pick positions in one statement under the deferred constraint', async () => {
    await dataSource.transaction(async (manager) => {
      await manager.query(
        `SET CONSTRAINTS "UQ_studio_curated_picks_shelf_position" DEFERRED`,
      );
      await manager.query(
        `UPDATE "studio_curated_picks" AS "pick" SET "position" = "ordering"."position"
           FROM unnest($1::uuid[], $2::smallint[]) AS "ordering"("pick_id", "position")
          WHERE "pick"."id" = "ordering"."pick_id"`,
        [
          [SECOND_PICK, FIRST_PICK],
          [1, 2],
        ],
      );
    });
    const rows: { id: string; position: number }[] = await dataSource.query(
      `SELECT "id", "position" FROM "studio_curated_picks" ORDER BY "position"`,
    );
    expect(rows.map((row) => row.id)).toEqual([SECOND_PICK, FIRST_PICK]);
  });

  it('refuses two picks at one position of a shelf', async () => {
    await expect(
      dataSource.query(
        `UPDATE "studio_curated_picks" SET "position" = 1 WHERE "id" = $1`,
        [FIRST_PICK],
      ),
    ).rejects.toThrow(/UQ_studio_curated_picks_shelf_position/);
  });

  it('follows a track and a release re-key with the credit and the pick attached', async () => {
    await dataSource.query(
      `UPDATE "studio_releases" SET "id" = $1 WHERE "id" = $2`,
      [RE_KEYED_RELEASE, RELEASE_ID],
    );
    await dataSource.query(
      `UPDATE "studio_tracks" SET "id" = $1 WHERE "id" = $2`,
      [RE_KEYED_TRACK, TRACK_ID],
    );
    await dataSource.query(
      `UPDATE "subprofiles" SET "id" = $1 WHERE "id" = $2`,
      [RE_KEYED_PERSONA, CREDITED_PERSONA],
    );

    const [credit] = await dataSource.query(
      `SELECT "track_id", "subprofile_id" FROM "studio_persona_credits" WHERE "id" = $1`,
      [CREDIT_ID],
    );
    expect(credit).toEqual({
      track_id: RE_KEYED_TRACK,
      subprofile_id: RE_KEYED_PERSONA,
    });
    const [pick] = await dataSource.query(
      `SELECT "release_id" FROM "studio_curated_picks" WHERE "id" = $1`,
      [FIRST_PICK],
    );
    expect(pick).toEqual({ release_id: RE_KEYED_RELEASE });
  });

  it('clears the scene of its releases when the scene is deleted', async () => {
    await dataSource.query(`DELETE FROM "studio_scenes" WHERE "id" = $1`, [
      SCENE_ID,
    ]);
    const [release] = await dataSource.query(
      `SELECT "scene_id", "mood" FROM "studio_releases" WHERE "id" = $1`,
      [RE_KEYED_RELEASE],
    );
    expect(release).toEqual({ scene_id: null, mood: 'late-night' });
  });

  it('deletes the credits of a persona that is deleted', async () => {
    await dataSource.query(`DELETE FROM "subprofiles" WHERE "id" = $1`, [
      RE_KEYED_PERSONA,
    ]);
    const credits = await dataSource.query(
      `SELECT 1 FROM "studio_persona_credits" WHERE "id" = $1`,
      [CREDIT_ID],
    );
    expect(credits).toEqual([]);
  });

  it('drops every table and type it created in down', async () => {
    await new AddStudioDiscovery1831800000000().down(queryRunner);
    const [leftovers] = await dataSource.query(
      `SELECT to_regclass('studio_persona_credits') AS "credits",
              to_regclass('studio_scenes') AS "scenes",
              to_regtype('studio_scenes_status_enum') AS "scene_status"`,
    );
    expect(leftovers).toEqual({
      credits: null,
      scenes: null,
      scene_status: null,
    });
  });
});

// The synchronized schema above already carries both labels (the entity
// enum lists them), so a label test there passes whatever the migration
// does. This block builds the type by hand from the label before it, the
// pattern of `studio-open-pages-migrations.postgres.spec.ts`.
describeWithDatabase(
  'AddStudioCreditNotificationTypes1831800100000 on real Postgres',
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
      // The type as it stands before this migration, cut down to its last
      // label (`1831700200000-AddStudioTakedownNotificationTypes`): the
      // migration only appends.
      await dataSource.query(
        `CREATE TYPE "notifications_type_enum" AS ENUM ('studio_release_dispute_decided')`,
      );
      queryRunner = dataSource.createQueryRunner();
    }, 120000);

    afterAll(async () => {
      await queryRunner?.release();
      await dataSource?.destroy();
    });

    const labels = async (): Promise<string[]> => {
      const rows: { label: string }[] = await dataSource.query(
        `SELECT unnest(enum_range(NULL::"notifications_type_enum"))::text AS "label"`,
      );
      return rows.map((row) => row.label);
    };

    it('appends both credit labels, and a second run changes nothing', async () => {
      await new AddStudioCreditNotificationTypes1831800100000().up(queryRunner);
      await new AddStudioCreditNotificationTypes1831800100000().up(queryRunner);
      expect(await labels()).toEqual([
        'studio_release_dispute_decided',
        'studio_credit_requested',
        'studio_credit_accepted',
      ]);
    });
  },
);
