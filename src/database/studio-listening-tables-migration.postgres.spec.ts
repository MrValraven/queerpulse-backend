// Lives in `src/database`, outside `src/migrations`: the TypeORM CLI and
// `DatabaseModule` require every `src/migrations/*.ts` file.
import { DataSource, QueryRunner } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { AddStudioListening1837800000000 } from '../migrations/1837800000000-AddStudioListening';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * Studio listening migration on real Postgres. Skipped unless
 * `STUDIO_MIGRATIONS_DATABASE_URL` names a database whose name ends in
 * `_test` (it drops and rebuilds the schema). Run it with, for example:
 *
 *   STUDIO_MIGRATIONS_DATABASE_URL=postgres://postgres@127.0.0.1:55450/studio_test \
 *     npx jest src/database/studio-listening-tables-migration.postgres.spec.ts
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const LISTENER = 'c9000000-0000-4000-8000-000000000001';
const CREATOR = 'c9000000-0000-4000-8000-000000000002';
const MUSICIAN_PERSONA = 'c9100000-0000-4000-8000-000000000001';
const SECOND_PERSONA = 'c9100000-0000-4000-8000-000000000002';
const RELEASE_ID = 'c9200000-0000-4000-8000-000000000001';
const TRACK_ID = 'c9300000-0000-4000-8000-000000000001';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

describeWithDatabase('AddStudioListening1837800000000 on real Postgres', () => {
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

  const insertPersona = (
    personaId: string,
    kind: string,
    slug: string,
  ): Promise<unknown> =>
    dataSource.query(
      `INSERT INTO "subprofiles" ("id", "user_id", "kind", "slug", "display_name")
       VALUES ($1, $2, $3, $4, $5)`,
      [personaId, CREATOR, kind, slug, slug],
    );

  const insertTrack = async (
    trackId: string,
    releaseId: string,
  ): Promise<void> => {
    await dataSource.query(
      `INSERT INTO "studio_tracks" ("id", "release_id", "position", "title", "audio_key", "duration_seconds")
       VALUES ($1, $2, 1, 'Night bus', 'studio-audio/a/b.mp3', 200)`,
      [trackId, releaseId],
    );
  };

  const insertDaily = (trackId: string): Promise<unknown> =>
    dataSource.query(
      `INSERT INTO "studio_track_play_daily" ("track_id", "day", "plays") VALUES ($1, '2026-10-27', 1)
       ON CONFLICT ("track_id", "day") DO UPDATE SET "plays" = "studio_track_play_daily"."plays" + 1`,
      [trackId],
    );

  const insertListen = (trackId: string, userId: string): Promise<unknown> =>
    dataSource.query(
      `INSERT INTO "studio_listens" ("user_id", "track_id") VALUES ($2, $1)`,
      [trackId, userId],
    );

  const insertSupporter = (
    userId: string,
    subprofileId: string,
    shownAsSubprofileId: string | null,
  ): Promise<unknown> =>
    dataSource.query(
      `INSERT INTO "studio_supporters" ("user_id", "subprofile_id", "shown_as_subprofile_id") VALUES ($1, $2, $3)`,
      [userId, subprofileId, shownAsSubprofileId],
    );

  const insertUser = (userId: string): Promise<unknown> =>
    dataSource.getRepository(User).insert({
      id: userId,
      googleId: `google-${userId}`,
      email: `${userId}@example.test`,
      status: UserStatus.Active,
    });

  const indexDefinitionsOf = async (indexName: string): Promise<string[]> => {
    const rows: { indexdef: string }[] = await dataSource.query(
      `SELECT "indexdef" FROM "pg_indexes" WHERE "indexname" = $1`,
      [indexName],
    );
    return rows.map((row) => row.indexdef);
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
    await dataSource.query(`DROP TABLE "studio_supporters"`);
    await dataSource.query(`DROP TABLE "studio_listens"`);
    await dataSource.query(`DROP TABLE "studio_track_play_daily"`);
    await dataSource.query(
      `ALTER TABLE "member_preferences" DROP COLUMN "is_listening_history_on", DROP COLUMN "listening_notice_seen_at"`,
    );
    await dataSource.query(
      `DROP INDEX IF EXISTS "IDX_studio_artist_milestones_track"`,
    );
    queryRunner = dataSource.createQueryRunner();

    await insertUser(LISTENER);
    await insertUser(CREATOR);
    await insertPersona(MUSICIAN_PERSONA, 'musician', 'night-bus');
    await insertPersona(SECOND_PERSONA, 'dj', 'low-tide');
    await dataSource.query(
      `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type", "status", "published_at")
       VALUES ($1, $2, 'Low tide', 'album', 'published', now())`,
      [RELEASE_ID, MUSICIAN_PERSONA],
    );
    await insertTrack(TRACK_ID, RELEASE_ID);
    await new AddStudioListening1837800000000().up(queryRunner);
  }, 120000);

  afterAll(async () => {
    await queryRunner?.release();
    await dataSource?.destroy();
  });

  it('adds a second play on the same track and day into one row', async () => {
    await insertDaily(TRACK_ID);
    await insertDaily(TRACK_ID);
    const rows: { plays: number }[] = await dataSource.query(
      `SELECT "plays" FROM "studio_track_play_daily" WHERE "track_id" = $1`,
      [TRACK_ID],
    );
    expect(rows.map((row) => row.plays)).toEqual([2]);
  });

  it('defaults a listen to now with millisecond precision', async () => {
    await insertListen(TRACK_ID, LISTENER);
    const defaulted: { id: string; played_at: Date | null }[] =
      await dataSource.query(
        `SELECT "id", "played_at" FROM "studio_listens" WHERE "user_id" = $1`,
        [LISTENER],
      );
    expect(defaulted.map((row) => UUID_PATTERN.test(row.id))).toEqual([true]);
    expect(defaulted.map((row) => row.played_at !== null)).toEqual([true]);
    await dataSource.query(
      `UPDATE "studio_listens" SET "played_at" = '2026-10-27T10:00:00.123456Z' WHERE "user_id" = $1`,
      [LISTENER],
    );
    const rounded: { played_at: Date }[] = await dataSource.query(
      `SELECT "played_at" FROM "studio_listens" WHERE "user_id" = $1`,
      [LISTENER],
    );
    expect(rounded.map((row) => row.played_at.getUTCMilliseconds())).toEqual([
      123,
    ]);
    await dataSource.query(`DELETE FROM "studio_listens"`);
  });

  it('refuses a supporter row shown as the artist persona itself', async () => {
    await expect(
      insertSupporter(LISTENER, MUSICIAN_PERSONA, MUSICIAN_PERSONA),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses a second opt-in of one member for one artist', async () => {
    await insertSupporter(LISTENER, MUSICIAN_PERSONA, null);
    await expect(
      insertSupporter(LISTENER, MUSICIAN_PERSONA, SECOND_PERSONA),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'PK_studio_supporters',
    });
    await dataSource.query(`DELETE FROM "studio_supporters"`);
  });

  it('deletes the opt-in when the chosen persona is deleted', async () => {
    await insertSupporter(LISTENER, MUSICIAN_PERSONA, SECOND_PERSONA);
    await dataSource.query(`DELETE FROM "subprofiles" WHERE "id" = $1`, [
      SECOND_PERSONA,
    ]);
    expect(
      await countRows('studio_supporters', `"user_id" = $1`, [LISTENER]),
    ).toEqual([0]);
    await insertPersona(SECOND_PERSONA, 'dj', 'low-tide');
  });

  it('deletes daily totals and listens with their track, and listens and opt-ins with their member', async () => {
    const doomedTrack = 'c9300000-0000-4000-8000-000000000002';
    const doomedMember = 'c9000000-0000-4000-8000-000000000003';
    await insertTrack(doomedTrack, RELEASE_ID);
    await insertUser(doomedMember);
    await insertDaily(doomedTrack);
    await insertListen(doomedTrack, LISTENER);
    await dataSource.query(`DELETE FROM "studio_tracks" WHERE "id" = $1`, [
      doomedTrack,
    ]);
    expect(
      await countRows('studio_track_play_daily', `"track_id" = $1`, [
        doomedTrack,
      ]),
    ).toEqual([0]);
    expect(
      await countRows('studio_listens', `"track_id" = $1`, [doomedTrack]),
    ).toEqual([0]);

    await insertListen(TRACK_ID, doomedMember);
    await insertSupporter(doomedMember, MUSICIAN_PERSONA, null);
    await dataSource.query(`DELETE FROM "users" WHERE "id" = $1`, [
      doomedMember,
    ]);
    expect(
      await countRows('studio_listens', `"user_id" = $1`, [doomedMember]),
    ).toEqual([0]);
    expect(
      await countRows('studio_supporters', `"user_id" = $1`, [doomedMember]),
    ).toEqual([0]);
  });

  it('carries daily totals, listens and opt-ins to a re-keyed track or persona id', async () => {
    const rekeyedTrack = 'c9300000-0000-4000-8000-000000000003';
    const freshTrack = 'c9300000-0000-4000-8000-000000000004';
    const rekeyedPersona = 'c9100000-0000-4000-8000-000000000003';
    const freshPersona = 'c9100000-0000-4000-8000-000000000004';
    await insertTrack(rekeyedTrack, RELEASE_ID);
    await insertDaily(rekeyedTrack);
    await insertListen(rekeyedTrack, LISTENER);
    await insertPersona(rekeyedPersona, 'musician', 'old-key');
    await insertSupporter(LISTENER, rekeyedPersona, SECOND_PERSONA);
    await insertSupporter(CREATOR, MUSICIAN_PERSONA, rekeyedPersona);

    await dataSource.query(
      `UPDATE "studio_tracks" SET "id" = $2 WHERE "id" = $1`,
      [rekeyedTrack, freshTrack],
    );
    await dataSource.query(
      `UPDATE "subprofiles" SET "id" = $2 WHERE "id" = $1`,
      [rekeyedPersona, freshPersona],
    );

    expect(
      await countRows('studio_track_play_daily', `"track_id" = $1`, [
        freshTrack,
      ]),
    ).toEqual([1]);
    expect(
      await countRows('studio_listens', `"track_id" = $1`, [freshTrack]),
    ).toEqual([1]);
    expect(
      await countRows('studio_supporters', `"subprofile_id" = $1`, [
        freshPersona,
      ]),
    ).toEqual([1]);
    expect(
      await countRows('studio_supporters', `"shown_as_subprofile_id" = $1`, [
        freshPersona,
      ]),
    ).toEqual([1]);
    await dataSource.query(`DELETE FROM "studio_tracks" WHERE "id" = $1`, [
      freshTrack,
    ]);
    await dataSource.query(`DELETE FROM "studio_supporters"`);
    await dataSource.query(`DELETE FROM "subprofiles" WHERE "id" = $1`, [
      freshPersona,
    ]);
  });

  it('orders the history index by played_at then id, both descending', async () => {
    const definitions = await indexDefinitionsOf(
      'IDX_studio_listens_user_played_at',
    );
    expect(definitions).toEqual([
      expect.stringContaining('(user_id, played_at DESC, id DESC)'),
    ]);
  });

  it('indexes the chosen persona only where one is set, and milestone tracks only where one is set', async () => {
    expect(await indexDefinitionsOf('IDX_studio_supporters_shown_as')).toEqual([
      expect.stringContaining('WHERE (shown_as_subprofile_id IS NOT NULL)'),
    ]);
    expect(
      await indexDefinitionsOf('IDX_studio_artist_milestones_track'),
    ).toEqual([expect.stringContaining('WHERE (track_id IS NOT NULL)')]);
  });

  it('adds the two preference columns with history on and no notice by default', async () => {
    await dataSource.query(
      `INSERT INTO "member_preferences" ("user_id") VALUES ($1)`,
      [LISTENER],
    );
    const rows: {
      is_listening_history_on: boolean;
      listening_notice_seen_at: Date | null;
    }[] = await dataSource.query(
      `SELECT "is_listening_history_on", "listening_notice_seen_at" FROM "member_preferences" WHERE "user_id" = $1`,
      [LISTENER],
    );
    expect(
      rows.map((row) => [
        row.is_listening_history_on,
        row.listening_notice_seen_at,
      ]),
    ).toEqual([[true, null]]);
  });

  it('drops the columns, the indexes and the three tables on down', async () => {
    await new AddStudioListening1837800000000().down(queryRunner);
    const tables: { table_name: string | null }[] = await dataSource.query(
      `SELECT to_regclass('public.studio_supporters') AS "table_name"
       UNION ALL SELECT to_regclass('public.studio_listens')
       UNION ALL SELECT to_regclass('public.studio_track_play_daily')`,
    );
    expect(tables.map((row) => row.table_name)).toEqual([null, null, null]);
    expect(
      await indexDefinitionsOf('IDX_studio_artist_milestones_track'),
    ).toEqual([]);
    const columns: { count: number }[] = await dataSource.query(
      `SELECT COUNT(*)::int AS "count" FROM "information_schema"."columns"
        WHERE "table_name" = 'member_preferences'
          AND "column_name" IN ('is_listening_history_on', 'listening_notice_seen_at')`,
    );
    expect(columns).toEqual([{ count: 0 }]);
  });
});
