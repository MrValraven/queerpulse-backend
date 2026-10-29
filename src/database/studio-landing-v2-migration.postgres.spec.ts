// Lives in `src/database`, outside `src/migrations`: the TypeORM CLI and
// `DatabaseModule` require every `src/migrations/*.ts` file.
import { DataSource, QueryRunner } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { AddStudioLandingV21838100000000 } from '../migrations/1838100000000-AddStudioLandingV2';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * Studio landing v2 migration on real Postgres. Skipped unless
 * `STUDIO_MIGRATIONS_DATABASE_URL` names a database whose name ends in
 * `_test` (it drops and rebuilds the schema). Run it with, for example:
 *
 *   STUDIO_MIGRATIONS_DATABASE_URL=postgres://postgres@127.0.0.1:55450/studio_test \
 *     npx jest src/database/studio-landing-v2-migration.postgres.spec.ts
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const ACTIVE_MEMBER = 'd1000000-0000-4000-8000-000000000001';
const SUSPENDED_MEMBER = 'd1000000-0000-4000-8000-000000000002';
const MUSICIAN_PERSONA = 'd1100000-0000-4000-8000-000000000001';
const RELEASE_ID = 'd1200000-0000-4000-8000-000000000001';
const TRACK_ID = 'd1300000-0000-4000-8000-000000000001';
const SECOND_TRACK_ID = 'd1300000-0000-4000-8000-000000000002';

const LANDING_TABLES = [
  'studio_access_requests',
  'studio_landing_settings',
  'studio_founding_artists',
  'studio_landing_photos',
  'studio_landing_artist_cards',
  'studio_landing_previews',
];

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

describeWithDatabase('AddStudioLandingV21838100000000 on real Postgres', () => {
  let dataSource: DataSource;
  let queryRunner: QueryRunner;

  const countRows = async (
    tableName: string,
    whereSql: string,
    parameters: unknown[],
  ): Promise<number[]> => {
    const rows: { count: number }[] = await dataSource.query(
      `SELECT COUNT(*)::int AS "count" FROM "${tableName}" WHERE ${whereSql}`,
      parameters,
    );
    return rows.map((row) => row.count);
  };

  const insertUser = (userId: string, status: UserStatus): Promise<unknown> =>
    dataSource.getRepository(User).insert({
      id: userId,
      googleId: `google-${userId}`,
      email: `${userId}@example.test`,
      status,
    });

  const insertPersona = (
    personaId: string,
    kind: string,
    slug: string,
  ): Promise<unknown> =>
    dataSource.query(
      `INSERT INTO "subprofiles" ("id", "user_id", "kind", "slug", "display_name")
       VALUES ($1, $2, $3, $4, $5)`,
      [personaId, ACTIVE_MEMBER, kind, slug, slug],
    );

  const insertTrack = (trackId: string, position: number): Promise<unknown> =>
    dataSource.query(
      `INSERT INTO "studio_tracks" ("id", "release_id", "position", "title", "audio_key", "duration_seconds")
       VALUES ($1, $2, $3, 'Night bus', 'studio-audio/a/b.mp3', 200)`,
      [trackId, RELEASE_ID, position],
    );

  const insertPreview = (
    trackId: string,
    status: string,
    position: number,
  ): Promise<unknown> =>
    dataSource.query(
      `INSERT INTO "studio_landing_previews" ("track_id", "status", "position") VALUES ($1, $2, $3)`,
      [trackId, status, position],
    );

  const insertCard = (
    personaId: string,
    position: number,
    hasConsent: boolean,
  ): Promise<unknown> =>
    dataSource.query(
      `INSERT INTO "studio_landing_artist_cards" ("subprofile_id", "position", "has_consent") VALUES ($1, $2, $3)`,
      [personaId, position, hasConsent],
    );

  const insertFounding = (
    personaId: string,
    position: number,
  ): Promise<unknown> =>
    dataSource.query(
      `INSERT INTO "studio_founding_artists" ("subprofile_id", "position") VALUES ($1, $2)`,
      [personaId, position],
    );

  const insertPhoto = (hasConsent: boolean): Promise<unknown> =>
    dataSource.query(
      `INSERT INTO "studio_landing_photos" ("slot", "image_key", "alt_text_en", "alt_text_pt", "has_consent")
       VALUES ('hero', 'landing/a/b', 'A crowd', 'Uma multidao', $1)`,
      [hasConsent],
    );

  const upsertVisit = (day: string, page: string): Promise<unknown> =>
    dataSource.query(
      `INSERT INTO "landing_visit_daily" ("day", "page", "source", "visits") VALUES ($1, $2, 'instagram', 1)
       ON CONFLICT ("day", "page", "source") DO UPDATE SET "visits" = "landing_visit_daily"."visits" + 1`,
      [day, page],
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
    // Everything this migration adds comes from the migration under review,
    // so drop what `synchronize` built from the entities first.
    for (const tableName of LANDING_TABLES) {
      await dataSource.query(`DROP TABLE IF EXISTS "${tableName}"`);
    }
    await dataSource.query(
      `DROP TYPE IF EXISTS "studio_landing_previews_status_enum"`,
    );
    await dataSource.query(
      `DROP TYPE IF EXISTS "studio_landing_photos_slot_enum"`,
    );
    await dataSource.query(
      `ALTER TABLE "landing_visit_daily" DROP CONSTRAINT IF EXISTS "CHK_landing_visit_daily_page"`,
    );
    const keyNames: { conname: string }[] = await dataSource.query(
      `SELECT "conname" FROM "pg_constraint"
        WHERE "conrelid" = 'landing_visit_daily'::regclass AND "contype" = 'p'`,
    );
    for (const keyName of keyNames) {
      await dataSource.query(
        `ALTER TABLE "landing_visit_daily" DROP CONSTRAINT "${keyName.conname}"`,
      );
    }
    await dataSource.query(
      `ALTER TABLE "landing_visit_daily" DROP COLUMN IF EXISTS "page"`,
    );
    await dataSource.query(
      `ALTER TABLE "landing_visit_daily" ADD CONSTRAINT "PK_landing_visit_daily" PRIMARY KEY ("day", "source")`,
    );
    queryRunner = dataSource.createQueryRunner();

    await insertUser(ACTIVE_MEMBER, UserStatus.Active);
    await insertUser(SUSPENDED_MEMBER, UserStatus.Suspended);
    await insertPersona(MUSICIAN_PERSONA, 'musician', 'night-bus');
    await dataSource.query(
      `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type", "status", "published_at")
       VALUES ($1, $2, 'Low tide', 'album', 'published', now())`,
      [RELEASE_ID, MUSICIAN_PERSONA],
    );
    await insertTrack(TRACK_ID, 1);
    await insertTrack(SECOND_TRACK_ID, 2);
    await dataSource.query(
      `INSERT INTO "landing_visit_daily" ("day", "source", "visits") VALUES ('2026-10-20', 'instagram', 4)`,
    );
    await new AddStudioLandingV21838100000000().up(queryRunner);
  }, 120000);

  afterAll(async () => {
    await queryRunner?.release();
    await dataSource?.destroy();
  });

  it('keeps an earlier visit row under the home page', async () => {
    const rows: { page: string; visits: number }[] = await dataSource.query(
      `SELECT "page", "visits" FROM "landing_visit_daily" WHERE "day" = '2026-10-20'`,
    );
    expect(rows.map((row) => [row.page, row.visits])).toEqual([['home', 4]]);
  });

  it('counts a home and a studio visit on one day and source in two rows', async () => {
    await upsertVisit('2026-10-21', 'home');
    await upsertVisit('2026-10-21', 'studio');
    await upsertVisit('2026-10-21', 'studio');
    const rows: { page: string; visits: number }[] = await dataSource.query(
      `SELECT "page", "visits" FROM "landing_visit_daily" WHERE "day" = '2026-10-21' ORDER BY "page"`,
    );
    expect(rows.map((row) => [row.page, row.visits])).toEqual([
      ['home', 1],
      ['studio', 2],
    ]);
  });

  it('refuses a page outside home and studio', async () => {
    await expect(upsertVisit('2026-10-22', 'blog')).rejects.toMatchObject({
      code: '23514',
      constraint: 'CHK_landing_visit_daily_page',
    });
  });

  it('refuses a second open preview of one track and allows one after a decline', async () => {
    await insertPreview(TRACK_ID, 'pending', 1);
    await expect(insertPreview(TRACK_ID, 'approved', 2)).rejects.toMatchObject({
      code: '23505',
    });
    await dataSource.query(
      `UPDATE "studio_landing_previews" SET "status" = 'declined' WHERE "track_id" = $1`,
      [TRACK_ID],
    );
    await expect(insertPreview(TRACK_ID, 'pending', 3)).resolves.toBeDefined();
    await dataSource.query(`DELETE FROM "studio_landing_previews"`);
  });

  it('refuses position 0 on previews, cards and founding rows', async () => {
    await expect(insertPreview(TRACK_ID, 'pending', 0)).rejects.toMatchObject({
      code: '23514',
      constraint: 'CHK_studio_landing_previews_position',
    });
    await expect(insertCard(MUSICIAN_PERSONA, 0, true)).rejects.toMatchObject({
      code: '23514',
      constraint: 'CHK_studio_landing_artist_cards_position',
    });
    await expect(insertFounding(MUSICIAN_PERSONA, 0)).rejects.toMatchObject({
      code: '23514',
      constraint: 'CHK_studio_founding_artists_position',
    });
  });

  it('refuses a card or a photo saved without consent', async () => {
    await expect(insertCard(MUSICIAN_PERSONA, 1, false)).rejects.toMatchObject({
      code: '23514',
      constraint: 'CHK_studio_landing_artist_cards_consent',
    });
    await expect(insertPhoto(false)).rejects.toMatchObject({
      code: '23514',
      constraint: 'CHK_studio_landing_photos_consent',
    });
    await expect(insertPhoto(true)).resolves.toBeDefined();
    await dataSource.query(`DELETE FROM "studio_landing_photos"`);
  });

  it('refuses a second card and a second founding row for one persona', async () => {
    await insertCard(MUSICIAN_PERSONA, 1, true);
    await expect(insertCard(MUSICIAN_PERSONA, 2, true)).rejects.toMatchObject({
      code: '23505',
      constraint: 'UQ_studio_landing_artist_cards_subprofile',
    });
    await insertFounding(MUSICIAN_PERSONA, 1);
    await expect(insertFounding(MUSICIAN_PERSONA, 2)).rejects.toMatchObject({
      code: '23505',
      constraint: 'UQ_studio_founding_artists_subprofile',
    });
    await dataSource.query(`DELETE FROM "studio_landing_artist_cards"`);
    await dataSource.query(`DELETE FROM "studio_founding_artists"`);
  });

  it('deletes cards and founding rows with their persona and previews with their track', async () => {
    const doomedPersona = 'd1100000-0000-4000-8000-000000000002';
    const doomedTrack = 'd1300000-0000-4000-8000-000000000003';
    await insertPersona(doomedPersona, 'dj', 'low-tide');
    await insertTrack(doomedTrack, 3);
    await insertCard(doomedPersona, 1, true);
    await insertFounding(doomedPersona, 1);
    await insertPreview(doomedTrack, 'approved', 1);

    await dataSource.query(`DELETE FROM "subprofiles" WHERE "id" = $1`, [
      doomedPersona,
    ]);
    await dataSource.query(`DELETE FROM "studio_tracks" WHERE "id" = $1`, [
      doomedTrack,
    ]);

    expect(
      await countRows('studio_landing_artist_cards', `"subprofile_id" = $1`, [
        doomedPersona,
      ]),
    ).toEqual([0]);
    expect(
      await countRows('studio_founding_artists', `"subprofile_id" = $1`, [
        doomedPersona,
      ]),
    ).toEqual([0]);
    expect(
      await countRows('studio_landing_previews', `"track_id" = $1`, [
        doomedTrack,
      ]),
    ).toEqual([0]);
  });

  it('carries cards, founding rows and previews to a re-keyed persona or track id', async () => {
    const rekeyedPersona = 'd1100000-0000-4000-8000-000000000003';
    const freshPersona = 'd1100000-0000-4000-8000-000000000004';
    const rekeyedTrack = 'd1300000-0000-4000-8000-000000000004';
    const freshTrack = 'd1300000-0000-4000-8000-000000000005';
    await insertPersona(rekeyedPersona, 'dj', 'old-key');
    await insertTrack(rekeyedTrack, 4);
    await insertCard(rekeyedPersona, 1, true);
    await insertFounding(rekeyedPersona, 1);
    await insertPreview(rekeyedTrack, 'pending', 1);

    await dataSource.query(
      `UPDATE "subprofiles" SET "id" = $2 WHERE "id" = $1`,
      [rekeyedPersona, freshPersona],
    );
    await dataSource.query(
      `UPDATE "studio_tracks" SET "id" = $2 WHERE "id" = $1`,
      [rekeyedTrack, freshTrack],
    );

    expect(
      await countRows('studio_landing_artist_cards', `"subprofile_id" = $1`, [
        freshPersona,
      ]),
    ).toEqual([1]);
    expect(
      await countRows('studio_founding_artists', `"subprofile_id" = $1`, [
        freshPersona,
      ]),
    ).toEqual([1]);
    expect(
      await countRows('studio_landing_previews', `"track_id" = $1`, [
        freshTrack,
      ]),
    ).toEqual([1]);
    await dataSource.query(`DELETE FROM "studio_landing_previews"`);
    await dataSource.query(`DELETE FROM "studio_tracks" WHERE "id" = $1`, [
      freshTrack,
    ]);
    await dataSource.query(`DELETE FROM "subprofiles" WHERE "id" = $1`, [
      freshPersona,
    ]);
  });

  it('sets the staff columns to null when the staff member is deleted', async () => {
    const staffMember = 'd1000000-0000-4000-8000-000000000003';
    await insertUser(staffMember, UserStatus.Active);
    await dataSource.query(
      `INSERT INTO "studio_landing_previews" ("track_id", "status", "position", "requested_by_id", "decided_by_id", "decided_at")
       VALUES ($1, 'approved', 1, $2, $2, now())`,
      [TRACK_ID, staffMember],
    );
    await dataSource.query(
      `INSERT INTO "studio_landing_artist_cards" ("subprofile_id", "position", "has_consent", "created_by_id") VALUES ($1, 1, true, $2)`,
      [MUSICIAN_PERSONA, staffMember],
    );
    await dataSource.query(
      `INSERT INTO "studio_landing_photos" ("slot", "image_key", "alt_text_en", "alt_text_pt", "has_consent", "updated_by_id")
       VALUES ('manifesto', 'landing/a/c', 'A stage', 'Um palco', true, $1)`,
      [staffMember],
    );
    await dataSource.query(
      `INSERT INTO "studio_founding_artists" ("subprofile_id", "position", "added_by_id") VALUES ($1, 1, $2)`,
      [MUSICIAN_PERSONA, staffMember],
    );
    await dataSource.query(
      `UPDATE "studio_landing_settings" SET "updated_by_id" = $1`,
      [staffMember],
    );

    await dataSource.query(`DELETE FROM "users" WHERE "id" = $1`, [
      staffMember,
    ]);

    const previewRows: {
      requested_by_id: string | null;
      decided_by_id: string | null;
    }[] = await dataSource.query(
      `SELECT "requested_by_id", "decided_by_id" FROM "studio_landing_previews"`,
    );
    expect(
      previewRows.map((row) => [row.requested_by_id, row.decided_by_id]),
    ).toEqual([[null, null]]);
    const staffColumns: { table_name: string; column_value: string | null }[] =
      await dataSource.query(
        `SELECT 'cards' AS "table_name", "created_by_id"::text AS "column_value" FROM "studio_landing_artist_cards"
         UNION ALL SELECT 'photos', "updated_by_id"::text FROM "studio_landing_photos"
         UNION ALL SELECT 'founding', "added_by_id"::text FROM "studio_founding_artists"
         UNION ALL SELECT 'settings', "updated_by_id"::text FROM "studio_landing_settings"`,
      );
    expect(
      staffColumns.map((row) => [row.table_name, row.column_value]),
    ).toEqual([
      ['cards', null],
      ['photos', null],
      ['founding', null],
      ['settings', null],
    ]);
    await dataSource.query(`DELETE FROM "studio_landing_previews"`);
    await dataSource.query(`DELETE FROM "studio_landing_artist_cards"`);
    await dataSource.query(`DELETE FROM "studio_landing_photos"`);
    await dataSource.query(`DELETE FROM "studio_founding_artists"`);
  });

  it('holds one settings row with the shelf visible', async () => {
    const rows: { id: number; is_founding_shelf_visible: boolean }[] =
      await dataSource.query(
        `SELECT "id", "is_founding_shelf_visible" FROM "studio_landing_settings"`,
      );
    expect(rows.map((row) => [row.id, row.is_founding_shelf_visible])).toEqual([
      [1, true],
    ]);
    await expect(
      dataSource.query(
        `INSERT INTO "studio_landing_settings" ("id") VALUES (2)`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses a second access request of one member and deletes it with the member', async () => {
    await dataSource.query(
      `INSERT INTO "studio_access_requests" ("user_id") VALUES ($1)`,
      [SUSPENDED_MEMBER],
    );
    const defaults: {
      wants_to_release: boolean;
      is_from_invite: boolean;
    }[] = await dataSource.query(
      `SELECT "wants_to_release", "is_from_invite" FROM "studio_access_requests" WHERE "user_id" = $1`,
      [SUSPENDED_MEMBER],
    );
    expect(
      defaults.map((row) => [row.wants_to_release, row.is_from_invite]),
    ).toEqual([[false, false]]);
    await expect(
      dataSource.query(
        `INSERT INTO "studio_access_requests" ("user_id", "wants_to_release") VALUES ($1, true)`,
        [SUSPENDED_MEMBER],
      ),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'UQ_studio_access_requests_user',
    });

    await dataSource.query(`DELETE FROM "users" WHERE "id" = $1`, [
      SUSPENDED_MEMBER,
    ]);
    expect(
      await countRows('studio_access_requests', `"user_id" = $1`, [
        SUSPENDED_MEMBER,
      ]),
    ).toEqual([0]);
  });

  it('drops the six tables, the enums and the page column on down', async () => {
    await new AddStudioLandingV21838100000000().down(queryRunner);

    const tables: { table_name: string | null }[] = await dataSource.query(
      LANDING_TABLES.map(
        (tableName) =>
          `SELECT to_regclass('public.${tableName}') AS "table_name"`,
      ).join(' UNION ALL '),
    );
    expect(tables.map((row) => row.table_name)).toEqual(
      LANDING_TABLES.map(() => null),
    );
    const enumTypes: { count: number }[] = await dataSource.query(
      `SELECT COUNT(*)::int AS "count" FROM "pg_type"
        WHERE "typname" IN ('studio_landing_previews_status_enum', 'studio_landing_photos_slot_enum')`,
    );
    expect(enumTypes).toEqual([{ count: 0 }]);

    const pageColumns: { count: number }[] = await dataSource.query(
      `SELECT COUNT(*)::int AS "count" FROM "information_schema"."columns"
        WHERE "table_name" = 'landing_visit_daily' AND "column_name" = 'page'`,
    );
    expect(pageColumns).toEqual([{ count: 0 }]);
    const keyColumns: { attname: string }[] = await dataSource.query(
      `SELECT "attribute"."attname" FROM "pg_index" "index_row"
         JOIN "pg_attribute" "attribute"
           ON "attribute"."attrelid" = "index_row"."indrelid"
          AND "attribute"."attnum" = ANY("index_row"."indkey")
        WHERE "index_row"."indrelid" = 'landing_visit_daily'::regclass
          AND "index_row"."indisprimary"
        ORDER BY "attribute"."attname"`,
    );
    expect(keyColumns.map((row) => row.attname)).toEqual(['day', 'source']);
    const remainingVisits: { day: string; visits: number }[] =
      await dataSource.query(
        `SELECT to_char("day", 'YYYY-MM-DD') AS "day", "visits" FROM "landing_visit_daily" ORDER BY "day"`,
      );
    expect(remainingVisits.map((row) => [row.day, row.visits])).toEqual([
      ['2026-10-20', 4],
      ['2026-10-21', 1],
    ]);
  });
});
