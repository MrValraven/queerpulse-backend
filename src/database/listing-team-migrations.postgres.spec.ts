// Lives in `src/database`, outside `src/migrations`: the TypeORM CLI and
// `DatabaseModule` require every `src/migrations/*.ts` file.
import { DataSource, QueryRunner } from 'typeorm';
import { AddListingTeamNotificationTypes1835100000000 } from '../migrations/1835100000000-AddListingTeamNotificationTypes';
import { AddListingTeamMembers1835100100000 } from '../migrations/1835100100000-AddListingTeamMembers';
import { AddListingTeamMemberUsers1838500000000 } from '../migrations/1838500000000-AddListingTeamMemberUsers';
import { AddListingTeamMemberNotificationTypes1838500100000 } from '../migrations/1838500100000-AddListingTeamMemberNotificationTypes';

/**
 * Meet the team migrations on real Postgres. Skipped unless
 * `STUDIO_MIGRATIONS_DATABASE_URL` names a database whose name ends in
 * `_test` (it drops the schema). Run it with, for example:
 *
 *   STUDIO_MIGRATIONS_DATABASE_URL=postgres://postgres@127.0.0.1:55450/team_test \
 *     npx jest src/database/listing-team-migrations.postgres.spec.ts
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const LISTING_ID = 'd5000000-0000-4000-8000-000000000001';
const OTHER_LISTING_ID = 'd5000000-0000-4000-8000-000000000002';
const PERSONA_ID = 'd5100000-0000-4000-8000-000000000001';
const OTHER_PERSONA_ID = 'd5100000-0000-4000-8000-000000000002';
const MOVED_PERSONA_ID = 'd5100000-0000-4000-8000-000000000003';
const REQUESTING_USER_ID = 'd5200000-0000-4000-8000-000000000001';
const MEMBER_USER_ID = 'd5200000-0000-4000-8000-000000000002';
const OTHER_MEMBER_USER_ID = 'd5200000-0000-4000-8000-000000000003';

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop the schema of "${databaseName}": the name must end in _test`,
    );
  }
}

interface PostgresError {
  code?: string;
  constraint?: string;
}

async function captureError(action: Promise<unknown>): Promise<PostgresError> {
  try {
    await action;
  } catch (error) {
    const driverError = (error as { driverError?: PostgresError }).driverError;
    return driverError ?? (error as PostgresError);
  }
  throw new Error('Expected the statement to fail');
}

describeWithDatabase(
  'AddListingTeamNotificationTypes1835100000000 on real Postgres',
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
        `CREATE TYPE "notifications_type_enum" AS ENUM ('studio_track_marked')`,
      );
      queryRunner = dataSource.createQueryRunner();
    }, 120000);

    afterAll(async () => {
      await queryRunner?.release();
      await dataSource?.destroy();
    });

    it('runs the enum migration outside the transaction, appends the three labels, and a second run changes nothing', async () => {
      const migration = new AddListingTeamNotificationTypes1835100000000();
      expect(migration.transaction).toBe(false);

      await migration.up(queryRunner);
      const labelsAfterFirstRun = await labelsOf('notifications_type_enum');
      expect(labelsAfterFirstRun.slice(-3)).toEqual([
        'listing_team_invite',
        'listing_team_request',
        'listing_team_accepted',
      ]);

      await migration.up(queryRunner);
      expect(await labelsOf('notifications_type_enum')).toEqual(
        labelsAfterFirstRun,
      );

      await expect(migration.down()).rejects.toThrow(/Irreversible/);
    });

    it('appends the two member labels outside the transaction, and a second run changes nothing', async () => {
      const migration =
        new AddListingTeamMemberNotificationTypes1838500100000();
      expect(migration.transaction).toBe(false);

      await migration.up(queryRunner);
      const labelsAfterFirstRun = await labelsOf('notifications_type_enum');
      expect(labelsAfterFirstRun.slice(-2)).toEqual([
        'listing_team_member_invite',
        'listing_team_member_accepted',
      ]);

      await migration.up(queryRunner);
      expect(await labelsOf('notifications_type_enum')).toEqual(
        labelsAfterFirstRun,
      );

      await expect(migration.down()).rejects.toThrow(/Irreversible/);
    });
  },
);

describeWithDatabase(
  'AddListingTeamMembers1835100100000 on real Postgres',
  () => {
    let dataSource: DataSource;
    let queryRunner: QueryRunner;

    const insertMember = (
      status: string,
      initiatedBy: string,
      position: number | null,
      roleLabel: string | null = null,
      subprofileId: string = PERSONA_ID,
    ): Promise<unknown> =>
      dataSource.query(
        `INSERT INTO "listing_team_members" ("listing_id", "subprofile_id", "role_label", "status", "initiated_by", "position")
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [LISTING_ID, subprofileId, roleLabel, status, initiatedBy, position],
      );

    const countRows = async (whereClause = 'TRUE'): Promise<number> => {
      const rows: { count: number }[] = await dataSource.query(
        `SELECT COUNT(*)::int AS "count" FROM "listing_team_members" WHERE ${whereClause}`,
      );
      const countRow = rows[0];
      expect(countRow).toBeDefined();
      return countRow?.count ?? -1;
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
      // The minimum the migration references.
      await dataSource.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
      await dataSource.query(`CREATE TABLE "users" ("id" uuid PRIMARY KEY)`);
      await dataSource.query(`CREATE TABLE "listings" ("id" uuid PRIMARY KEY)`);
      await dataSource.query(
        `CREATE TABLE "subprofiles" ("id" uuid PRIMARY KEY)`,
      );
      queryRunner = dataSource.createQueryRunner();
      await new AddListingTeamMembers1835100100000().up(queryRunner);
    }, 120000);

    afterAll(async () => {
      await queryRunner?.release();
      await dataSource?.destroy();
    });

    beforeEach(async () => {
      await dataSource.query(`INSERT INTO "users" ("id") VALUES ($1)`, [
        REQUESTING_USER_ID,
      ]);
      for (const listingId of [LISTING_ID, OTHER_LISTING_ID]) {
        await dataSource.query(`INSERT INTO "listings" ("id") VALUES ($1)`, [
          listingId,
        ]);
      }
      for (const personaId of [PERSONA_ID, OTHER_PERSONA_ID]) {
        await dataSource.query(`INSERT INTO "subprofiles" ("id") VALUES ($1)`, [
          personaId,
        ]);
      }
    });

    afterEach(async () => {
      const [regclassRow]: { table_name: string | null }[] =
        await dataSource.query(
          `SELECT to_regclass('listing_team_members') AS "table_name"`,
        );
      if (regclassRow?.table_name) {
        await dataSource.query(`DELETE FROM "listing_team_members"`);
      }
      await dataSource.query(`DELETE FROM "listings"`);
      await dataSource.query(`DELETE FROM "subprofiles"`);
      await dataSource.query(`DELETE FROM "users"`);
    });

    it('creates the index on the requesting member key', async () => {
      const indexRows: { indexname: string }[] = await dataSource.query(
        `SELECT "indexname" FROM "pg_indexes" WHERE "tablename" = 'listing_team_members' AND "indexname" = 'IDX_listing_team_members_requested_by_user_id'`,
      );
      expect(indexRows).toEqual([
        { indexname: 'IDX_listing_team_members_requested_by_user_id' },
      ]);
    });

    it('refuses a second live row for one pair and accepts a new pending row after a decline', async () => {
      await insertMember('pending', 'listing', null);
      const secondLiveRowError = await captureError(
        insertMember('pending', 'persona', null),
      );
      expect(secondLiveRowError.code).toBe('23505');
      expect(secondLiveRowError.constraint).toBe(
        'UQ_listing_team_members_live_pair',
      );

      await dataSource.query(
        `UPDATE "listing_team_members" SET "status" = 'declined', "answered_at" = now() WHERE "listing_id" = $1`,
        [LISTING_ID],
      );
      await insertMember('pending', 'persona', null);
      expect(await countRows(`"status" = 'pending'`)).toBe(1);
    });

    it('skips a second live row through the partial index conflict target', async () => {
      await insertMember('pending', 'listing', null);
      const conflictingRows: { id: string }[] = await dataSource.query(
        `INSERT INTO "listing_team_members" ("listing_id", "subprofile_id", "initiated_by")
         VALUES ($1, $2, 'persona')
         ON CONFLICT ("listing_id", "subprofile_id") WHERE "status" IN ('pending', 'accepted') DO NOTHING
         RETURNING "id"`,
        [LISTING_ID, PERSONA_ID],
      );
      expect(conflictingRows).toEqual([]);
      expect(
        await countRows(
          `"listing_id" = '${LISTING_ID}' AND "subprofile_id" = '${PERSONA_ID}'`,
        ),
      ).toBe(1);
    });

    it('refuses an accepted row without a position and a pending row with one', async () => {
      const acceptedWithoutPosition = await captureError(
        insertMember('accepted', 'listing', null),
      );
      expect(acceptedWithoutPosition.code).toBe('23514');
      expect(acceptedWithoutPosition.constraint).toBe(
        'CHK_listing_team_members_position',
      );

      const pendingWithPosition = await captureError(
        insertMember('pending', 'listing', 1),
      );
      expect(pendingWithPosition.code).toBe('23514');
      expect(pendingWithPosition.constraint).toBe(
        'CHK_listing_team_members_position',
      );
    });

    it('refuses a role label over 40 characters', async () => {
      const longRoleLabelError = await captureError(
        insertMember('pending', 'listing', null, 'a'.repeat(41)),
      );
      expect(longRoleLabelError.code).toBe('22001');
      await insertMember('pending', 'listing', null, 'a'.repeat(40));
    });

    it('follows a persona id change and deletes with the persona and the listing', async () => {
      await insertMember('pending', 'listing', null);
      await dataSource.query(
        `UPDATE "subprofiles" SET "id" = $1 WHERE "id" = $2`,
        [MOVED_PERSONA_ID, PERSONA_ID],
      );
      const movedRows: { subprofile_id: string }[] = await dataSource.query(
        `SELECT "subprofile_id" FROM "listing_team_members"`,
      );
      expect(movedRows).toEqual([{ subprofile_id: MOVED_PERSONA_ID }]);

      await dataSource.query(`DELETE FROM "subprofiles" WHERE "id" = $1`, [
        MOVED_PERSONA_ID,
      ]);
      expect(await countRows()).toBe(0);

      await insertMember('pending', 'listing', null, null, OTHER_PERSONA_ID);
      expect(await countRows()).toBe(1);
      await dataSource.query(`DELETE FROM "listings" WHERE "id" = $1`, [
        LISTING_ID,
      ]);
      expect(await countRows()).toBe(0);
    });

    it('keeps the row when the requesting member is erased', async () => {
      await dataSource.query(
        `INSERT INTO "listing_team_members" ("listing_id", "subprofile_id", "initiated_by", "requested_by_user_id")
         VALUES ($1, $2, 'persona', $3)`,
        [LISTING_ID, PERSONA_ID, REQUESTING_USER_ID],
      );
      await dataSource.query(`DELETE FROM "users" WHERE "id" = $1`, [
        REQUESTING_USER_ID,
      ]);
      const rows: { requested_by_user_id: string | null }[] =
        await dataSource.query(
          `SELECT "requested_by_user_id" FROM "listing_team_members"`,
        );
      expect(rows).toEqual([{ requested_by_user_id: null }]);
    });

    it('drops the table and both types on down', async () => {
      await new AddListingTeamMembers1835100100000().down(queryRunner);
      const [regclassRow]: { table_name: string | null }[] =
        await dataSource.query(
          `SELECT to_regclass('listing_team_members') AS "table_name"`,
        );
      const enumTypes: { count: number }[] = await dataSource.query(
        `SELECT COUNT(*)::int AS "count" FROM "pg_type" WHERE "typname" LIKE 'listing_team_members_%_enum'`,
      );
      expect(regclassRow).toBeDefined();
      expect(regclassRow?.table_name).toBeNull();
      expect(enumTypes).toEqual([{ count: 0 }]);
    });
  },
);

describeWithDatabase(
  'AddListingTeamMemberUsers1838500000000 on real Postgres',
  () => {
    let dataSource: DataSource;
    let queryRunner: QueryRunner;

    const insertPersonaRow = (
      status: string,
      initiatedBy: string,
      position: number | null,
      subprofileId: string = PERSONA_ID,
      listingId: string = LISTING_ID,
    ): Promise<unknown> =>
      dataSource.query(
        `INSERT INTO "listing_team_members" ("listing_id", "subprofile_id", "status", "initiated_by", "position")
         VALUES ($1, $2, $3, $4, $5)`,
        [listingId, subprofileId, status, initiatedBy, position],
      );

    const insertMemberRow = (
      status: string,
      initiatedBy: string,
      position: number | null,
      userId: string = MEMBER_USER_ID,
      listingId: string = LISTING_ID,
    ): Promise<unknown> =>
      dataSource.query(
        `INSERT INTO "listing_team_members" ("listing_id", "user_id", "status", "initiated_by", "position")
         VALUES ($1, $2, $3, $4, $5)`,
        [listingId, userId, status, initiatedBy, position],
      );

    const countRows = async (whereClause = 'TRUE'): Promise<number> => {
      const rows: { count: number }[] = await dataSource.query(
        `SELECT COUNT(*)::int AS "count" FROM "listing_team_members" WHERE ${whereClause}`,
      );
      const countRow = rows[0];
      expect(countRow).toBeDefined();
      return countRow?.count ?? -1;
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
      // The minimum the two migrations reference.
      await dataSource.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
      await dataSource.query(`CREATE TABLE "users" ("id" uuid PRIMARY KEY)`);
      await dataSource.query(`CREATE TABLE "listings" ("id" uuid PRIMARY KEY)`);
      await dataSource.query(
        `CREATE TABLE "subprofiles" ("id" uuid PRIMARY KEY)`,
      );
      queryRunner = dataSource.createQueryRunner();
      await new AddListingTeamMembers1835100100000().up(queryRunner);
      await new AddListingTeamMemberUsers1838500000000().up(queryRunner);
    }, 120000);

    afterAll(async () => {
      await queryRunner?.release();
      await dataSource?.destroy();
    });

    beforeEach(async () => {
      for (const userId of [MEMBER_USER_ID, OTHER_MEMBER_USER_ID]) {
        await dataSource.query(`INSERT INTO "users" ("id") VALUES ($1)`, [
          userId,
        ]);
      }
      for (const listingId of [LISTING_ID, OTHER_LISTING_ID]) {
        await dataSource.query(`INSERT INTO "listings" ("id") VALUES ($1)`, [
          listingId,
        ]);
      }
      for (const personaId of [PERSONA_ID, OTHER_PERSONA_ID]) {
        await dataSource.query(`INSERT INTO "subprofiles" ("id") VALUES ($1)`, [
          personaId,
        ]);
      }
    });

    afterEach(async () => {
      const [regclassRow]: { table_name: string | null }[] =
        await dataSource.query(
          `SELECT to_regclass('listing_team_members') AS "table_name"`,
        );
      if (regclassRow?.table_name) {
        await dataSource.query(`DELETE FROM "listing_team_members"`);
      }
      await dataSource.query(`DELETE FROM "listings"`);
      await dataSource.query(`DELETE FROM "subprofiles"`);
      await dataSource.query(`DELETE FROM "users"`);
    });

    it('creates the member key, both checks and both indexes', async () => {
      const constraintRows: { conname: string }[] = await dataSource.query(
        `SELECT "conname" FROM "pg_constraint" WHERE "conrelid" = 'listing_team_members'::regclass AND "conname" IN ('FK_listing_team_members_user', 'CHK_listing_team_members_one_subject', 'CHK_listing_team_members_member_listing_initiated') ORDER BY "conname"`,
      );
      expect(constraintRows.map((row) => row.conname)).toEqual([
        'CHK_listing_team_members_member_listing_initiated',
        'CHK_listing_team_members_one_subject',
        'FK_listing_team_members_user',
      ]);
      const indexRows: { indexname: string }[] = await dataSource.query(
        `SELECT "indexname" FROM "pg_indexes" WHERE "tablename" = 'listing_team_members' AND "indexname" IN ('UQ_listing_team_members_live_member', 'IDX_listing_team_members_user_status') ORDER BY "indexname"`,
      );
      expect(indexRows.map((row) => row.indexname)).toEqual([
        'IDX_listing_team_members_user_status',
        'UQ_listing_team_members_live_member',
      ]);
    });

    it('accepts a persona row and a member row, and refuses a row with both subjects or neither', async () => {
      await insertPersonaRow('pending', 'listing', null);
      await insertMemberRow('pending', 'listing', null);
      expect(await countRows()).toBe(2);

      const bothSubjectsError = await captureError(
        dataSource.query(
          `INSERT INTO "listing_team_members" ("listing_id", "subprofile_id", "user_id", "initiated_by")
           VALUES ($1, $2, $3, 'listing')`,
          [OTHER_LISTING_ID, OTHER_PERSONA_ID, OTHER_MEMBER_USER_ID],
        ),
      );
      expect(bothSubjectsError.code).toBe('23514');
      expect(bothSubjectsError.constraint).toBe(
        'CHK_listing_team_members_one_subject',
      );

      const noSubjectError = await captureError(
        dataSource.query(
          `INSERT INTO "listing_team_members" ("listing_id", "initiated_by")
           VALUES ($1, 'listing')`,
          [OTHER_LISTING_ID],
        ),
      );
      expect(noSubjectError.code).toBe('23514');
      expect(noSubjectError.constraint).toBe(
        'CHK_listing_team_members_one_subject',
      );
    });

    it('refuses a member row started by the persona side', async () => {
      const personaInitiatedError = await captureError(
        insertMemberRow('pending', 'persona', null),
      );
      expect(personaInitiatedError.code).toBe('23514');
      expect(personaInitiatedError.constraint).toBe(
        'CHK_listing_team_members_member_listing_initiated',
      );
      await insertPersonaRow('pending', 'persona', null);
    });

    it('refuses a second live row for one listing and member and accepts a new one after a decline', async () => {
      await insertMemberRow('pending', 'listing', null);
      const secondLiveRowError = await captureError(
        insertMemberRow('pending', 'listing', null),
      );
      expect(secondLiveRowError.code).toBe('23505');
      expect(secondLiveRowError.constraint).toBe(
        'UQ_listing_team_members_live_member',
      );

      await insertMemberRow(
        'pending',
        'listing',
        null,
        MEMBER_USER_ID,
        OTHER_LISTING_ID,
      );
      await insertMemberRow('pending', 'listing', null, OTHER_MEMBER_USER_ID);

      await dataSource.query(
        `UPDATE "listing_team_members" SET "status" = 'declined', "answered_at" = now() WHERE "listing_id" = $1 AND "user_id" = $2`,
        [LISTING_ID, MEMBER_USER_ID],
      );
      await insertMemberRow('pending', 'listing', null);
      expect(
        await countRows(
          `"user_id" = '${MEMBER_USER_ID}' AND "status" = 'pending'`,
        ),
      ).toBe(2);
    });

    it('keeps the persona unique index and its conflict target working next to member rows', async () => {
      await insertMemberRow('pending', 'listing', null);
      await insertPersonaRow('pending', 'listing', null);
      // Member rows carry a NULL subprofile id, which the unique index treats as distinct.
      await insertMemberRow('pending', 'listing', null, OTHER_MEMBER_USER_ID);

      const conflictingRows: { id: string }[] = await dataSource.query(
        `INSERT INTO "listing_team_members" ("listing_id", "subprofile_id", "initiated_by")
         VALUES ($1, $2, 'persona')
         ON CONFLICT ("listing_id", "subprofile_id") WHERE "status" IN ('pending', 'accepted') DO NOTHING
         RETURNING "id"`,
        [LISTING_ID, PERSONA_ID],
      );
      expect(conflictingRows).toEqual([]);

      const duplicatePersonaError = await captureError(
        insertPersonaRow('pending', 'persona', null),
      );
      expect(duplicatePersonaError.constraint).toBe(
        'UQ_listing_team_members_live_pair',
      );
    });

    it('keeps the position rule for member rows', async () => {
      const acceptedWithoutPosition = await captureError(
        insertMemberRow('accepted', 'listing', null),
      );
      expect(acceptedWithoutPosition.constraint).toBe(
        'CHK_listing_team_members_position',
      );
      await insertMemberRow('accepted', 'listing', 1);
    });

    it('deletes member rows with the member and with the listing', async () => {
      await insertMemberRow('pending', 'listing', null);
      await dataSource.query(`DELETE FROM "users" WHERE "id" = $1`, [
        MEMBER_USER_ID,
      ]);
      expect(await countRows()).toBe(0);

      await insertMemberRow('pending', 'listing', null, OTHER_MEMBER_USER_ID);
      await dataSource.query(`DELETE FROM "listings" WHERE "id" = $1`, [
        LISTING_ID,
      ]);
      expect(await countRows()).toBe(0);
    });

    it('removes the member rows and restores the persona-only shape on down', async () => {
      await insertPersonaRow('pending', 'listing', null);
      await insertMemberRow('pending', 'listing', null);
      await new AddListingTeamMemberUsers1838500000000().down(queryRunner);

      expect(await countRows()).toBe(1);
      const columnRows: { column_name: string; is_nullable: string }[] =
        await dataSource.query(
          `SELECT "column_name", "is_nullable" FROM "information_schema"."columns" WHERE "table_name" = 'listing_team_members' AND "column_name" IN ('user_id', 'subprofile_id')`,
        );
      expect(columnRows).toEqual([
        { column_name: 'subprofile_id', is_nullable: 'NO' },
      ]);
      const leftovers: { name: string }[] = await dataSource.query(
        `SELECT "conname" AS "name" FROM "pg_constraint" WHERE "conrelid" = 'listing_team_members'::regclass AND "conname" IN ('CHK_listing_team_members_one_subject', 'CHK_listing_team_members_member_listing_initiated', 'FK_listing_team_members_user')
         UNION ALL
         SELECT "indexname" FROM "pg_indexes" WHERE "tablename" = 'listing_team_members' AND "indexname" IN ('UQ_listing_team_members_live_member', 'IDX_listing_team_members_user_status')`,
      );
      expect(leftovers).toEqual([]);
    });
  },
);
