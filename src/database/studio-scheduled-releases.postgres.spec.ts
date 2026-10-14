// Lives in `src/database` beside the other Postgres specs.
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { SCHEDULED_RELEASE_CLAIM_SQL } from '../studio/studio-scheduled-releases.service';
import {
  Subprofile,
  SubprofileKind,
} from '../subprofiles/entities/subprofile.entity';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * The scheduled drop on real Postgres. Skipped unless
 * `STUDIO_MIGRATIONS_DATABASE_URL` names a database whose name ends in
 * `_test` (it drops and synchronizes the schema from the entities).
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const OWNER = 'cb000000-0000-4000-8000-000000000001';
const PERSONA = 'cc000000-0000-4000-8000-000000000001';
const DUE_EARLIER = 'cd000000-0000-4000-8000-000000000001';
const DUE_LATER = 'cd000000-0000-4000-8000-000000000002';
const DUE_LAST = 'cd000000-0000-4000-8000-000000000003';
const FUTURE = 'cd000000-0000-4000-8000-000000000004';
const DRAFT = 'cd000000-0000-4000-8000-000000000005';
const DUE_THEN_TAKEN_DOWN = 'cd000000-0000-4000-8000-000000000006';
const DUE_WITHOUT_DATE = 'cd000000-0000-4000-8000-000000000007';
const DUE_WITH_TYPED_DATE = 'cd000000-0000-4000-8000-000000000008';

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

describeWithDatabase('Studio scheduled drop SQL on real Postgres', () => {
  let dataSource: DataSource;

  const rowOf = async (
    releaseId: string,
  ): Promise<{
    status: string;
    published_at: Date | null;
    publish_at: Date | null;
  }> => {
    const rows: {
      status: string;
      published_at: Date | null;
      publish_at: Date | null;
    }[] = await dataSource.query(
      `SELECT "status"::text AS "status", "published_at", "publish_at"
         FROM "studio_releases" WHERE "id" = $1`,
      [releaseId],
    );
    return rows[0]!;
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
    await dataSource.getRepository(User).insert({
      id: OWNER,
      googleId: `google-${OWNER}`,
      email: `${OWNER}@example.test`,
      status: UserStatus.Active,
    });
    await dataSource.getRepository(Subprofile).insert({
      id: PERSONA,
      userId: OWNER,
      slug: 'night-shift',
      displayName: 'Night Shift',
      kind: SubprofileKind.Dj,
    });
    await dataSource.query(
      `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type", "status", "publish_at")
       VALUES ($1, $6, 'Earlier', 'mix', 'scheduled', '2026-01-01T10:00:00.000Z'),
              ($2, $6, 'Later', 'mix', 'scheduled', '2026-01-01T11:00:00.000Z'),
              ($3, $6, 'Last', 'mix', 'scheduled', '2026-01-01T12:00:00.000Z'),
              ($4, $6, 'Future', 'mix', 'scheduled', now() + interval '1 day'),
              ($5, $6, 'Draft', 'mix', 'draft', NULL)`,
      [DUE_EARLIER, DUE_LATER, DUE_LAST, FUTURE, DRAFT, PERSONA],
    );
  }, 120000);

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('publishes only scheduled releases whose time has come, oldest first, up to the limit', async () => {
    const firstTick: { release_id: string }[] = await dataSource.query(
      SCHEDULED_RELEASE_CLAIM_SQL,
      [2],
    );
    expect(firstTick.map((row) => row.release_id).sort()).toEqual(
      [DUE_EARLIER, DUE_LATER].sort(),
    );
    expect(await rowOf(DUE_EARLIER)).toEqual({
      status: 'published',
      published_at: new Date('2026-01-01T10:00:00.000Z'),
      publish_at: null,
    });
    expect((await rowOf(DUE_LAST)).status).toBe('scheduled');
  });

  it('claims each due release once across two ticks and leaves the future and the draft alone', async () => {
    const secondTick: { release_id: string }[] = await dataSource.query(
      SCHEDULED_RELEASE_CLAIM_SQL,
      [100],
    );
    expect(secondTick).toEqual([{ release_id: DUE_LAST }]);
    const thirdTick: { release_id: string }[] = await dataSource.query(
      SCHEDULED_RELEASE_CLAIM_SQL,
      [100],
    );
    expect(thirdTick).toEqual([]);
    expect((await rowOf(FUTURE)).status).toBe('scheduled');
    expect((await rowOf(DRAFT)).status).toBe('draft');
  });

  it('never picks a due release that was taken down, which the takedown left without a time', async () => {
    await dataSource.query(
      `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type", "status", "publish_at")
       VALUES ($1, $2, 'Taken down', 'mix', 'scheduled', '2026-01-01T09:00:00.000Z')`,
      [DUE_THEN_TAKEN_DOWN, PERSONA],
    );
    await dataSource.query(
      `UPDATE "studio_releases"
          SET "status" = 'taken_down', "publish_at" = NULL, "taken_down_at" = now()
        WHERE "id" = $1`,
      [DUE_THEN_TAKEN_DOWN],
    );
    const tick: { release_id: string }[] = await dataSource.query(
      SCHEDULED_RELEASE_CLAIM_SQL,
      [100],
    );
    expect(tick).toEqual([]);
    expect(await rowOf(DUE_THEN_TAKEN_DOWN)).toEqual({
      status: 'taken_down',
      published_at: null,
      publish_at: null,
    });
  });

  it('fills an empty release date with the Lisbon date of publish_at and keeps a typed one', async () => {
    // 23:30 UTC on 31 July is 00:30 on 1 August in Lisbon (summer time).
    await dataSource.query(
      `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type", "status", "publish_at", "released_on")
       VALUES ($1, $3, 'No date', 'mix', 'scheduled', '2026-07-31T23:30:00.000Z', NULL),
              ($2, $3, 'Typed date', 'mix', 'scheduled', '2026-07-31T23:30:00.000Z', '2026-05-05')`,
      [DUE_WITHOUT_DATE, DUE_WITH_TYPED_DATE, PERSONA],
    );
    const tick: { release_id: string }[] = await dataSource.query(
      SCHEDULED_RELEASE_CLAIM_SQL,
      [100],
    );
    expect(tick.map((row) => row.release_id).sort()).toEqual(
      [DUE_WITHOUT_DATE, DUE_WITH_TYPED_DATE].sort(),
    );
    const releaseDateOf = async (releaseId: string): Promise<string | null> => {
      const rows: { released_on: string | null }[] = await dataSource.query(
        `SELECT "released_on"::text AS "released_on"
           FROM "studio_releases" WHERE "id" = $1`,
        [releaseId],
      );
      return rows[0]!.released_on;
    };
    expect(await releaseDateOf(DUE_WITHOUT_DATE)).toBe('2026-08-01');
    expect(await releaseDateOf(DUE_WITH_TYPED_DATE)).toBe('2026-05-05');
    expect(await rowOf(DUE_WITHOUT_DATE)).toEqual({
      status: 'published',
      published_at: new Date('2026-07-31T23:30:00.000Z'),
      publish_at: null,
    });
  });
});
