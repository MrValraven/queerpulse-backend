// Lives in `src/database`, outside `src/migrations`: the TypeORM CLI and
// `DatabaseModule` require every `src/migrations/*.ts` file.
import { DataSource, QueryRunner } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { AddStudioPlaybackPreferences1831700000000 } from '../migrations/1831700000000-AddStudioPlaybackPreferences';
import { AddStudioReleaseDisputes1831700100000 } from '../migrations/1831700100000-AddStudioReleaseDisputes';
import { AddStudioTakedownNotificationTypes1831700200000 } from '../migrations/1831700200000-AddStudioTakedownNotificationTypes';
import {
  Subprofile,
  SubprofileKind,
} from '../subprofiles/entities/subprofile.entity';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * The open demo pages migrations on real Postgres. Skipped unless
 * `STUDIO_MIGRATIONS_DATABASE_URL` names a database whose name ends in
 * `_test` (it drops and synchronizes the schema). Run it with, for example:
 *
 *   STUDIO_MIGRATIONS_DATABASE_URL=postgres://postgres@127.0.0.1:55450/studio_test \
 *     npx jest src/database/studio-open-pages-migrations.postgres.spec.ts
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const OWNER_USER = 'a1000000-0000-4000-8000-000000000001';
const STAFF_USER = 'a1000000-0000-4000-8000-000000000002';
const PERSONA_ID = 'a2000000-0000-4000-8000-000000000001';
const RELEASE_ID = 'a3000000-0000-4000-8000-000000000001';
const REKEYED_RELEASE = 'a3000000-0000-4000-8000-000000000002';

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

async function seedUsers(
  dataSource: DataSource,
  userIds: string[],
): Promise<void> {
  await dataSource.getRepository(User).insert(
    userIds.map((userId) => ({
      id: userId,
      googleId: `google-${userId}`,
      email: `${userId}@example.test`,
      status: UserStatus.Active,
    })),
  );
}

describeWithDatabase(
  'AddStudioPlaybackPreferences1831700000000 on real Postgres',
  () => {
    let dataSource: DataSource;
    let queryRunner: QueryRunner;

    const playbackRow = async (): Promise<
      {
        studio_autoplay_next: boolean;
        studio_hide_explicit: boolean;
        studio_crossfade_seconds: number;
      }[]
    > =>
      dataSource.query(
        `SELECT "studio_autoplay_next", "studio_hide_explicit", "studio_crossfade_seconds"
           FROM "member_preferences" WHERE "user_id" = $1`,
        [OWNER_USER],
      );

    beforeAll(async () => {
      refuseUnlessTestDatabase(DATABASE_URL!);
      dataSource = await synchronizedDataSource();
      // The three columns and the check come from the migration under
      // review, so drop what `synchronize` built from the entity.
      await dataSource.query(
        `ALTER TABLE "member_preferences" DROP CONSTRAINT IF EXISTS "CHK_member_preferences_studio_crossfade_seconds"`,
      );
      await dataSource.query(
        `ALTER TABLE "member_preferences"
           DROP COLUMN "studio_autoplay_next",
           DROP COLUMN "studio_hide_explicit",
           DROP COLUMN "studio_crossfade_seconds"`,
      );
      await seedUsers(dataSource, [OWNER_USER]);
      await dataSource.query(
        `INSERT INTO "member_preferences" ("user_id") VALUES ($1)`,
        [OWNER_USER],
      );
      queryRunner = dataSource.createQueryRunner();
      await new AddStudioPlaybackPreferences1831700000000().up(queryRunner);
    }, 120000);

    afterAll(async () => {
      await queryRunner?.release();
      await dataSource?.destroy();
    });

    it('gives an existing preferences row the player defaults', async () => {
      expect(await playbackRow()).toEqual([
        {
          studio_autoplay_next: true,
          studio_hide_explicit: false,
          studio_crossfade_seconds: 0,
        },
      ]);
    });

    it('stores a crossfade of up to 12 seconds', async () => {
      await dataSource.query(
        `UPDATE "member_preferences" SET "studio_crossfade_seconds" = 12 WHERE "user_id" = $1`,
        [OWNER_USER],
      );
      expect((await playbackRow())[0]?.studio_crossfade_seconds).toBe(12);
    });

    it.each([13, -1])(
      'refuses a crossfade of %i seconds',
      async (crossfadeSeconds) => {
        await expect(
          dataSource.query(
            `UPDATE "member_preferences" SET "studio_crossfade_seconds" = $2 WHERE "user_id" = $1`,
            [OWNER_USER, crossfadeSeconds],
          ),
        ).rejects.toThrow(/CHK_member_preferences_studio_crossfade_seconds/);
      },
    );

    it('runs down and up again', async () => {
      await new AddStudioPlaybackPreferences1831700000000().down(queryRunner);
      const columns: { column_name: string }[] = await dataSource.query(
        `SELECT "column_name" FROM "information_schema"."columns"
          WHERE "table_name" = 'member_preferences' AND "column_name" LIKE 'studio_%'`,
      );
      expect(columns).toEqual([]);
      await new AddStudioPlaybackPreferences1831700000000().up(queryRunner);
    });
  },
);

describeWithDatabase(
  'AddStudioReleaseDisputes1831700100000 on real Postgres',
  () => {
    let dataSource: DataSource;
    let queryRunner: QueryRunner;

    const disputeRows = async (): Promise<
      {
        release_id: string;
        status: string;
        decided_by_id: string | null;
      }[]
    > =>
      dataSource.query(
        `SELECT "release_id", "status"::text AS "status", "decided_by_id"
           FROM "studio_release_disputes" ORDER BY "created_at", "id"`,
      );

    beforeAll(async () => {
      refuseUnlessTestDatabase(DATABASE_URL!);
      dataSource = await synchronizedDataSource();
      // The table and its type come from the migration under review.
      await dataSource.query(`DROP TABLE "studio_release_disputes"`);
      await dataSource.query(`DROP TYPE "studio_release_disputes_status_enum"`);
      await seedUsers(dataSource, [OWNER_USER, STAFF_USER]);
      await dataSource.getRepository(Subprofile).insert({
        id: PERSONA_ID,
        userId: OWNER_USER,
        slug: 'night-shift',
        displayName: 'Night Shift',
        kind: SubprofileKind.Dj,
      });
      await dataSource.query(
        `INSERT INTO "studio_releases"
           ("id", "subprofile_id", "title", "type", "status", "published_at", "taken_down_at", "takedown_reason")
         VALUES ($1, $2, 'Lisbon at four', 'mix', 'taken_down', now(), now(), 'Uploaded without the rights')`,
        [RELEASE_ID, PERSONA_ID],
      );
      queryRunner = dataSource.createQueryRunner();
      await new AddStudioReleaseDisputes1831700100000().up(queryRunner);
    }, 120000);

    afterAll(async () => {
      await queryRunner?.release();
      await dataSource?.destroy();
    });

    it('stores no member id: a dispute names its release and the deciding staff member only', async () => {
      const columns: { column_name: string }[] = await dataSource.query(
        `SELECT "column_name" FROM "information_schema"."columns"
          WHERE "table_name" = 'studio_release_disputes' ORDER BY "column_name"`,
      );
      expect(columns.map((column) => column.column_name)).toEqual([
        'created_at',
        'decided_at',
        'decided_by_id',
        'id',
        'note',
        'release_id',
        'staff_reply',
        'status',
      ]);
    });

    it('opens a dispute by default, with no reply and no decision time', async () => {
      const rows: {
        status: string;
        staff_reply: string | null;
        decided_at: Date | null;
      }[] = await dataSource.query(
        `INSERT INTO "studio_release_disputes" ("release_id", "note")
         VALUES ($1, 'I hold the rights to every recording')
         RETURNING "status"::text AS "status", "staff_reply", "decided_at"`,
        [RELEASE_ID],
      );
      expect(rows).toEqual([
        { status: 'open', staff_reply: null, decided_at: null },
      ]);
    });

    it('refuses a second open dispute on one release', async () => {
      await expect(
        dataSource.query(
          `INSERT INTO "studio_release_disputes" ("release_id", "note") VALUES ($1, 'Again')`,
          [RELEASE_ID],
        ),
      ).rejects.toThrow(/UQ_studio_release_disputes_open_release/);
    });

    it('refuses a decided dispute without its reply and time', async () => {
      await expect(
        dataSource.query(
          `UPDATE "studio_release_disputes" SET "status" = 'rejected' WHERE "release_id" = $1`,
          [RELEASE_ID],
        ),
      ).rejects.toThrow(/CHK_studio_release_disputes_decision/);
    });

    it('takes a new dispute once the open one is decided', async () => {
      await dataSource.query(
        `UPDATE "studio_release_disputes"
            SET "status" = 'rejected', "staff_reply" = 'The label wrote to us',
                "decided_at" = now(), "decided_by_id" = $2
          WHERE "release_id" = $1 AND "status" = 'open'`,
        [RELEASE_ID, STAFF_USER],
      );
      await dataSource.query(
        `INSERT INTO "studio_release_disputes" ("release_id", "note") VALUES ($1, 'Here is the licence')`,
        [RELEASE_ID],
      );
      expect((await disputeRows()).map((row) => row.status)).toEqual([
        'rejected',
        'open',
      ]);
    });

    it('keeps a decision when the deciding staff account goes', async () => {
      await dataSource.query(`DELETE FROM "users" WHERE "id" = $1`, [
        STAFF_USER,
      ]);
      expect(await disputeRows()).toEqual([
        { release_id: RELEASE_ID, status: 'rejected', decided_by_id: null },
        { release_id: RELEASE_ID, status: 'open', decided_by_id: null },
      ]);
    });

    it('carries disputes to the fresh id an unlink issues', async () => {
      await dataSource.query(
        `UPDATE "studio_releases" SET "id" = $1 WHERE "id" = $2`,
        [REKEYED_RELEASE, RELEASE_ID],
      );
      expect((await disputeRows()).map((row) => row.release_id)).toEqual([
        REKEYED_RELEASE,
        REKEYED_RELEASE,
      ]);
    });

    it('removes disputes along with their release', async () => {
      await dataSource.query(`DELETE FROM "studio_releases" WHERE "id" = $1`, [
        REKEYED_RELEASE,
      ]);
      expect(await disputeRows()).toEqual([]);
    });

    it('runs down and up again', async () => {
      await new AddStudioReleaseDisputes1831700100000().down(queryRunner);
      const remaining: { table_name: string }[] = await dataSource.query(
        `SELECT "table_name" FROM "information_schema"."tables"
          WHERE "table_name" = 'studio_release_disputes'`,
      );
      expect(remaining).toEqual([]);
      await new AddStudioReleaseDisputes1831700100000().up(queryRunner);
    });
  },
);

describeWithDatabase(
  'AddStudioTakedownNotificationTypes1831700200000 on real Postgres',
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
      // The type as it stands before this migration, cut down to one
      // label: the migration only appends.
      await dataSource.query(
        `CREATE TYPE "notifications_type_enum" AS ENUM ('studio_release_published')`,
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

    it('runs outside the migration transaction', () => {
      expect(
        new AddStudioTakedownNotificationTypes1831700200000().transaction,
      ).toBe(false);
    });

    it('appends both labels, and a second run changes nothing', async () => {
      await new AddStudioTakedownNotificationTypes1831700200000().up(
        queryRunner,
      );
      await new AddStudioTakedownNotificationTypes1831700200000().up(
        queryRunner,
      );
      expect(await labels()).toEqual([
        'studio_release_published',
        'studio_release_taken_down',
        'studio_release_dispute_decided',
      ]);
    });

    it('refuses to run down', async () => {
      await expect(
        new AddStudioTakedownNotificationTypes1831700200000().down(),
      ).rejects.toThrow(/Irreversible/);
    });
  },
);
