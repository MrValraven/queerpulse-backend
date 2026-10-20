// Lives in `src/database`, outside `src/migrations`: the TypeORM CLI and
// `DatabaseModule` require every `src/migrations/*.ts` file.
import { DataSource, QueryRunner } from 'typeorm';
import { AddCreatorDrafts1835000000000 } from '../migrations/1835000000000-AddCreatorDrafts';

/**
 * Creator drafts migration on real Postgres. Skipped unless
 * `CREATOR_DRAFTS_DATABASE_URL` names a database whose name ends in `_test`
 * (it drops and rebuilds the schema). Run it with, for example:
 *
 *   CREATOR_DRAFTS_DATABASE_URL=postgres://postgres@127.0.0.1:55450/creator_drafts_test \
 *     npx jest src/database/creator-drafts-migration.postgres.spec.ts
 */
const DATABASE_URL = process.env.CREATOR_DRAFTS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const AUTHOR_ID = 'c8000000-0000-4000-8000-000000000001';
const LISTING_ID = 'c8100000-0000-4000-8000-000000000001';

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

describeWithDatabase('AddCreatorDrafts1835000000000 on real Postgres', () => {
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
    await dataSource.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await dataSource.query(`CREATE TABLE "users" ("id" uuid PRIMARY KEY)`);
    await dataSource.query(
      `CREATE TABLE "communities" ("id" uuid PRIMARY KEY)`,
    );
    await dataSource.query(`CREATE TABLE "listings" ("id" uuid PRIMARY KEY)`);
    queryRunner = dataSource.createQueryRunner();
    await new AddCreatorDrafts1835000000000().up(queryRunner);
  });

  afterAll(async () => {
    await queryRunner?.release();
    await dataSource?.destroy();
  });

  it('creates the kind enum with the three stored kinds', async () => {
    const rows: { label: string }[] = await dataSource.query(
      `SELECT unnest(enum_range(NULL::"creator_drafts_kind_enum"))::text AS "label"`,
    );
    expect(rows.map((row) => row.label)).toEqual([
      'event',
      'listing_edit',
      'community',
    ]);
  });

  it('keeps one draft per author per kind and slot', async () => {
    await dataSource.query(`INSERT INTO "users" ("id") VALUES ($1)`, [
      AUTHOR_ID,
    ]);
    const insert = `INSERT INTO "creator_drafts" ("user_id", "kind", "payload", "payload_version") VALUES ($1, 'event', '{}', 1)`;
    await dataSource.query(insert, [AUTHOR_ID]);
    await expect(dataSource.query(insert, [AUTHOR_ID])).rejects.toThrow(
      /UQ_creator_drafts_user_kind_slot/,
    );
  });

  it('defaults slot key, revision and the millisecond timestamps', async () => {
    const [row] = await dataSource.query(
      `SELECT "slot_key", "revision", "created_at", "updated_at" FROM "creator_drafts" WHERE "user_id" = $1`,
      [AUTHOR_ID],
    );
    expect(row).toEqual(expect.objectContaining({ slot_key: '', revision: 1 }));
    const [precision] = await dataSource.query(
      `SELECT "datetime_precision" FROM information_schema.columns WHERE "table_name" = 'creator_drafts' AND "column_name" = 'updated_at'`,
    );
    expect(precision.datetime_precision).toBe(3);
  });

  it('names both list and purge indexes', async () => {
    const rows: { indexname: string; indexdef: string }[] =
      await dataSource.query(
        `SELECT "indexname", "indexdef" FROM pg_indexes WHERE "tablename" = 'creator_drafts'`,
      );
    const definitions = new Map(
      rows.map((row) => [row.indexname, row.indexdef]),
    );
    expect(definitions.get('IDX_creator_drafts_kind_updated_at')).toMatch(
      /\(kind, updated_at DESC, id DESC\)/,
    );
    expect(definitions.get('IDX_creator_drafts_updated_at')).toMatch(
      /\(updated_at\)/,
    );
  });

  it('cascades with the author and sets made-for refs null when their target goes', async () => {
    await dataSource.query(`INSERT INTO "listings" ("id") VALUES ($1)`, [
      LISTING_ID,
    ]);
    await dataSource.query(
      `INSERT INTO "creator_drafts" ("user_id", "kind", "slot_key", "payload", "payload_version", "made_for_listing_id") VALUES ($1, 'listing_edit', $2, '{}', 1, $3)`,
      [AUTHOR_ID, LISTING_ID, LISTING_ID],
    );
    await dataSource.query(`DELETE FROM "listings" WHERE "id" = $1`, [
      LISTING_ID,
    ]);
    const [orphan] = await dataSource.query(
      `SELECT "made_for_listing_id" FROM "creator_drafts" WHERE "kind" = 'listing_edit'`,
    );
    expect(orphan.made_for_listing_id).toBeNull();
    await dataSource.query(`DELETE FROM "users" WHERE "id" = $1`, [AUTHOR_ID]);
    const [{ count }] = await dataSource.query(
      `SELECT COUNT(*)::int AS "count" FROM "creator_drafts"`,
    );
    expect(count).toBe(0);
  });

  it('drops the table and the enum on down', async () => {
    await new AddCreatorDrafts1835000000000().down(queryRunner);
    const [{ exists }] = await dataSource.query(
      `SELECT to_regclass('creator_drafts') IS NOT NULL AS "exists"`,
    );
    expect(exists).toBe(false);
  });
});
