// Lives in `src/database`, outside `src/migrations`: the TypeORM CLI and
// `DatabaseModule` require every `src/migrations/*.ts` file.
import { readFileSync } from 'fs';
import { join } from 'path';
import { DataSource, QueryRunner } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { AddStudioArtistMilestones1837700000000 } from '../migrations/1837700000000-AddStudioArtistMilestones';
import { STUDIO_ARTIST_PERSONA_KINDS } from '../studio/studio.constants';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * Studio artist milestones migration on real Postgres. Skipped unless
 * `STUDIO_MIGRATIONS_DATABASE_URL` names a database whose name ends in
 * `_test` (it drops and rebuilds the schema). Run it with, for example:
 *
 *   STUDIO_MIGRATIONS_DATABASE_URL=postgres://postgres@127.0.0.1:55450/studio_test \
 *     npx jest src/database/studio-artist-milestones-migration.postgres.spec.ts
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const OWNER_USER = 'c8000000-0000-4000-8000-000000000001';
const MUSICIAN_PERSONA = 'c8100000-0000-4000-8000-000000000001';
const DJ_PERSONA = 'c8100000-0000-4000-8000-000000000002';
const DEVELOPER_PERSONA = 'c8100000-0000-4000-8000-000000000003';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIRST_FOLLOW_BASE = '2026-01-01T00:00:00.000Z';

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

describe('AddStudioArtistMilestones1837700000000 source', () => {
  it('names every Studio artist kind in the backfill', () => {
    const source = readFileSync(
      join(
        __dirname,
        '..',
        'migrations',
        '1837700000000-AddStudioArtistMilestones.ts',
      ),
      'utf8',
    );
    for (const kind of STUDIO_ARTIST_PERSONA_KINDS) {
      expect(source).toContain(`'${kind}'`);
    }
  });
});

describeWithDatabase(
  'AddStudioArtistMilestones1837700000000 on real Postgres',
  () => {
    let dataSource: DataSource;
    let queryRunner: QueryRunner;

    const labelsOf = async (typeName: string): Promise<string[]> => {
      const rows: { label: string }[] = await dataSource.query(
        `SELECT unnest(enum_range(NULL::"${typeName}"))::text AS "label"`,
      );
      return rows.map((row) => row.label);
    };

    const thresholdsOf = async (
      subprofileId: string,
      kind: string,
    ): Promise<number[]> => {
      const rows: { threshold: number }[] = await dataSource.query(
        `SELECT "threshold" FROM "studio_artist_milestones"
          WHERE "subprofile_id" = $1 AND "kind" = $2
          ORDER BY "threshold" ASC`,
        [subprofileId, kind],
      );
      return rows.map((row) => row.threshold);
    };

    const insertPersona = (
      personaId: string,
      kind: string,
      slug: string,
    ): Promise<unknown> =>
      dataSource.query(
        `INSERT INTO "subprofiles" ("id", "user_id", "kind", "slug", "display_name")
         VALUES ($1, $2, $3, $4, $5)`,
        [personaId, OWNER_USER, kind, slug, slug],
      );

    /** Follower number N follows N minutes after `FIRST_FOLLOW_BASE`, and
     *  they are inserted newest first, so the backfill has to order them by
     *  `created_at` to date each threshold right. */
    const insertFollowers = (
      personaId: string,
      followerCount: number,
    ): Promise<unknown> =>
      dataSource.query(
        `INSERT INTO "subprofile_followers" ("subprofile_id", "follower_id", "created_at")
         SELECT $1::uuid, gen_random_uuid(), $3::timestamptz + make_interval(mins => "follower_number")
           FROM generate_series($2::int, 1, -1) AS "follower_number"`,
        [personaId, followerCount, FIRST_FOLLOW_BASE],
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
      await dataSource.query(`DROP TABLE "studio_artist_milestones"`);
      await dataSource.query(`DROP TYPE "studio_artist_milestones_kind_enum"`);
      queryRunner = dataSource.createQueryRunner();

      await dataSource.getRepository(User).insert({
        id: OWNER_USER,
        googleId: `google-${OWNER_USER}`,
        email: `${OWNER_USER}@example.test`,
        status: UserStatus.Active,
      });
      await insertPersona(MUSICIAN_PERSONA, 'musician', 'night-bus');
      await insertPersona(DJ_PERSONA, 'dj', 'low-tide');
      await insertPersona(DEVELOPER_PERSONA, 'developer', 'patch-notes');
      await insertFollowers(MUSICIAN_PERSONA, 27);
      await insertFollowers(DJ_PERSONA, 9);
      await insertFollowers(DEVELOPER_PERSONA, 30);
      await new AddStudioArtistMilestones1837700000000().up(queryRunner);
    }, 120000);

    afterAll(async () => {
      await queryRunner?.release();
      await dataSource?.destroy();
    });

    it('creates the kind enum with the four labels in contract order', async () => {
      expect(await labelsOf('studio_artist_milestones_kind_enum')).toEqual([
        'followers',
        'first_placement',
        'track_plays',
        'artist_plays',
      ]);
    });

    it('backfills every follower threshold at or below the count for an artist persona', async () => {
      expect(await thresholdsOf(MUSICIAN_PERSONA, 'followers')).toEqual([
        10, 25,
      ]);
    });

    it("dates each backfilled follower milestone at the matching follower's created_at", async () => {
      const rows: { threshold: number; reached_at: Date }[] =
        await dataSource.query(
          `SELECT "threshold", "reached_at" FROM "studio_artist_milestones"
            WHERE "subprofile_id" = $1 AND "kind" = 'followers'
            ORDER BY "threshold" ASC`,
          [MUSICIAN_PERSONA],
        );
      const tenthFollowers: { created_at: Date }[] = await dataSource.query(
        `SELECT "created_at" FROM "subprofile_followers"
          WHERE "subprofile_id" = $1
          ORDER BY "created_at" ASC, "id" ASC
          OFFSET 9 LIMIT 1`,
        [MUSICIAN_PERSONA],
      );
      const tenthFollowerDates = tenthFollowers.map((follower) =>
        follower.created_at.toISOString(),
      );
      expect(tenthFollowerDates).toEqual(['2026-01-01T00:10:00.000Z']);
      expect(
        rows.map((row) => [row.threshold, row.reached_at.toISOString()]),
      ).toEqual([
        [10, ...tenthFollowerDates],
        [25, '2026-01-01T00:25:00.000Z'],
      ]);
    });

    it('writes nothing for an artist persona under ten followers', async () => {
      expect(await thresholdsOf(DJ_PERSONA, 'followers')).toEqual([]);
    });

    it('writes nothing for a persona of another kind', async () => {
      expect(await thresholdsOf(DEVELOPER_PERSONA, 'followers')).toEqual([]);
    });

    it('refuses a second row for the same persona, kind and threshold with no track', async () => {
      await expect(
        dataSource.query(
          `INSERT INTO "studio_artist_milestones" ("subprofile_id", "kind", "threshold") VALUES ($1, 'followers', 10)`,
          [MUSICIAN_PERSONA],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('gives each milestone a uuid and a reached date', async () => {
      const rows: { id: string; reached_at: Date | null }[] =
        await dataSource.query(
          `SELECT "id", "reached_at" FROM "studio_artist_milestones" WHERE "subprofile_id" = $1`,
          [MUSICIAN_PERSONA],
        );
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.id).toMatch(UUID_PATTERN);
        expect(row.reached_at).not.toBeNull();
      }
    });

    it('deletes the milestones with their persona', async () => {
      await dataSource.query(`DELETE FROM "subprofiles" WHERE "id" = $1`, [
        MUSICIAN_PERSONA,
      ]);
      const rows: { count: number }[] = await dataSource.query(
        `SELECT COUNT(*)::int AS "count" FROM "studio_artist_milestones" WHERE "subprofile_id" = $1`,
        [MUSICIAN_PERSONA],
      );
      expect(rows).toEqual([{ count: 0 }]);
    });

    it('drops the table and the type on down', async () => {
      await new AddStudioArtistMilestones1837700000000().down(queryRunner);
      const tables: { table_name: string | null }[] = await dataSource.query(
        `SELECT to_regclass('public.studio_artist_milestones') AS "table_name"`,
      );
      const enumTypes: { count: number }[] = await dataSource.query(
        `SELECT COUNT(*)::int AS "count" FROM "pg_type" WHERE "typname" = 'studio_artist_milestones_kind_enum'`,
      );
      expect(tables).toEqual([{ table_name: null }]);
      expect(enumTypes).toEqual([{ count: 0 }]);
    });
  },
);
