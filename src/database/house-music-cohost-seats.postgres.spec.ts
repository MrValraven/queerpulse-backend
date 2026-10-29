// Lives in `src/database`, outside `src/migrations`: the TypeORM CLI and
// `DatabaseModule` require every `src/migrations/*.ts` file.
import { DataSource, QueryRunner } from 'typeorm';
import {
  cohostSeatRefusalFor,
  lockCohostSeatsForMember,
  removeHouseMusicCohostSeats,
} from '../events/house-music-events';

/**
 * House Music co-host seat rules on real Postgres. Skipped unless
 * `MUSIC_EVENTS_DATABASE_URL` names a database whose name ends in `_test`
 * (it drops the schema). Run it with, for example:
 *
 *   MUSIC_EVENTS_DATABASE_URL=postgres://postgres@127.0.0.1:55450/music_test \
 *     npx jest src/database/house-music-cohost-seats.postgres.spec.ts
 */
const DATABASE_URL = process.env.MUSIC_EVENTS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const HOUSE_ID = 'e4100000-0000-4000-8000-000000000001';
const MEMBER_ID = 'e4100000-0000-4000-8000-000000000002';
const SECOND_MEMBER_ID = 'e4100000-0000-4000-8000-000000000003';
const MODERATOR_ID = 'e4100000-0000-4000-8000-000000000004';
const GRANT_HOLDER_ID = 'e4100000-0000-4000-8000-000000000005';

const HOUSE_MUSIC_EVENT_ID = 'e4200000-0000-4000-8000-000000000001';
const SECOND_HOUSE_MUSIC_EVENT_ID = 'e4200000-0000-4000-8000-000000000002';
const HOUSE_PARTY_EVENT_ID = 'e4200000-0000-4000-8000-000000000003';
const MEMBER_MUSIC_EVENT_ID = 'e4200000-0000-4000-8000-000000000004';

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop the schema of "${databaseName}": the name must end in _test`,
    );
  }
}

function waitMilliseconds(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describeWithDatabase('house Music co-host seats on real Postgres', () => {
  let dataSource: DataSource;

  const insertUser = (
    userId: string,
    role: string,
    googleId: string | null = null,
  ): Promise<unknown> =>
    dataSource.query(
      `INSERT INTO "users" ("id", "google_id", "role") VALUES ($1, $2, $3)`,
      [userId, googleId, role],
    );

  const insertEvent = (
    eventId: string,
    slug: string,
    hostId: string,
    family: string,
  ): Promise<unknown> =>
    dataSource.query(
      `INSERT INTO "events" ("id", "slug", "title", "host_id", "gathering_family")
       VALUES ($1, $2, $3, $4, $5)`,
      [eventId, slug, `Title of ${slug}`, hostId, family],
    );

  const insertCohost = (
    cohostRowId: string,
    eventId: string,
    userId: string,
  ): Promise<unknown> =>
    dataSource.query(
      `INSERT INTO "event_cohosts" ("id", "event_id", "user_id") VALUES ($1, $2, $3)`,
      [cohostRowId, eventId, userId],
    );

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
    // The minimum the helpers reference.
    await dataSource.query(
      `CREATE TYPE "users_role_enum" AS ENUM ('member', 'moderator', 'admin')`,
    );
    await dataSource.query(
      `CREATE TABLE "users" (
         "id" uuid PRIMARY KEY,
         "google_id" varchar UNIQUE,
         "role" "users_role_enum" NOT NULL DEFAULT 'member'
       )`,
    );
    await dataSource.query(
      `CREATE TABLE "user_staff_roles" (
         "user_id" uuid NOT NULL REFERENCES "users" ("id"),
         "role" varchar NOT NULL,
         UNIQUE ("user_id", "role")
       )`,
    );
    await dataSource.query(
      `CREATE TYPE "events_gathering_family_enum" AS ENUM ('party', 'music')`,
    );
    await dataSource.query(
      `CREATE TABLE "events" (
         "id" uuid PRIMARY KEY,
         "slug" varchar NOT NULL UNIQUE,
         "title" varchar NOT NULL,
         "host_id" uuid REFERENCES "users" ("id"),
         "gathering_family" "events_gathering_family_enum"
       )`,
    );
    await dataSource.query(
      `CREATE TABLE "event_cohosts" (
         "id" uuid PRIMARY KEY,
         "event_id" uuid NOT NULL REFERENCES "events" ("id"),
         "user_id" uuid NOT NULL REFERENCES "users" ("id"),
         UNIQUE ("event_id", "user_id")
       )`,
    );

    await insertUser(HOUSE_ID, 'member', 'system:queerpulse');
    await insertUser(MEMBER_ID, 'member');
    await insertUser(SECOND_MEMBER_ID, 'member');
    await insertUser(MODERATOR_ID, 'moderator');
    await insertUser(GRANT_HOLDER_ID, 'member');
    await dataSource.query(
      `INSERT INTO "user_staff_roles" ("user_id", "role") VALUES ($1, 'music_manager_producer')`,
      [GRANT_HOLDER_ID],
    );
  }, 120000);

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('removes only house Music seats of the member and returns their slugs', async () => {
    await insertEvent(HOUSE_MUSIC_EVENT_ID, 'house-music-b', HOUSE_ID, 'music');
    await insertEvent(
      SECOND_HOUSE_MUSIC_EVENT_ID,
      'house-music-a',
      HOUSE_ID,
      'music',
    );
    await insertEvent(HOUSE_PARTY_EVENT_ID, 'house-party', HOUSE_ID, 'party');
    await insertEvent(
      MEMBER_MUSIC_EVENT_ID,
      'member-music',
      SECOND_MEMBER_ID,
      'music',
    );
    await insertCohost(
      'e4300000-0000-4000-8000-000000000001',
      HOUSE_MUSIC_EVENT_ID,
      MEMBER_ID,
    );
    await insertCohost(
      'e4300000-0000-4000-8000-000000000002',
      SECOND_HOUSE_MUSIC_EVENT_ID,
      MEMBER_ID,
    );
    await insertCohost(
      'e4300000-0000-4000-8000-000000000003',
      HOUSE_PARTY_EVENT_ID,
      MEMBER_ID,
    );
    await insertCohost(
      'e4300000-0000-4000-8000-000000000004',
      MEMBER_MUSIC_EVENT_ID,
      MEMBER_ID,
    );
    await insertCohost(
      'e4300000-0000-4000-8000-000000000005',
      HOUSE_MUSIC_EVENT_ID,
      SECOND_MEMBER_ID,
    );

    const removedSeats = await removeHouseMusicCohostSeats(
      dataSource.manager,
      MEMBER_ID,
    );
    expect(removedSeats).toEqual([
      {
        eventId: SECOND_HOUSE_MUSIC_EVENT_ID,
        eventSlug: 'house-music-a',
        eventTitle: 'Title of house-music-a',
      },
      {
        eventId: HOUSE_MUSIC_EVENT_ID,
        eventSlug: 'house-music-b',
        eventTitle: 'Title of house-music-b',
      },
    ]);

    const remainingSeats: { event_id: string; user_id: string }[] =
      await dataSource.query(
        `SELECT "event_id", "user_id" FROM "event_cohosts" ORDER BY "id"`,
      );
    expect(remainingSeats).toEqual([
      { event_id: HOUSE_PARTY_EVENT_ID, user_id: MEMBER_ID },
      { event_id: MEMBER_MUSIC_EVENT_ID, user_id: MEMBER_ID },
      { event_id: HOUSE_MUSIC_EVENT_ID, user_id: SECOND_MEMBER_ID },
    ]);

    await expect(
      removeHouseMusicCohostSeats(dataSource.manager, MEMBER_ID),
    ).resolves.toEqual([]);
  });

  it('answers holds_grant, is_staff_tier and null for a holder, a moderator and a member', async () => {
    await dataSource.query(
      `INSERT INTO "user_staff_roles" ("user_id", "role") VALUES ($1, 'music_manager_producer')`,
      [MODERATOR_ID],
    );
    const moderatorHoldingGrant = await cohostSeatRefusalFor(
      dataSource.manager,
      MODERATOR_ID,
    );
    await dataSource.query(
      `DELETE FROM "user_staff_roles" WHERE "user_id" = $1`,
      [MODERATOR_ID],
    );

    expect({
      holder: await cohostSeatRefusalFor(dataSource.manager, GRANT_HOLDER_ID),
      moderator: await cohostSeatRefusalFor(dataSource.manager, MODERATOR_ID),
      member: await cohostSeatRefusalFor(dataSource.manager, MEMBER_ID),
      moderatorHoldingGrant,
    }).toEqual({
      holder: 'music_event_cohost_holds_grant',
      moderator: 'music_event_cohost_is_staff_tier',
      member: null,
      moderatorHoldingGrant: 'music_event_cohost_holds_grant',
    });
  });

  it('lets a second transaction wait on the seat lock until the first commits', async () => {
    const firstRunner: QueryRunner = dataSource.createQueryRunner();
    const secondRunner: QueryRunner = dataSource.createQueryRunner();
    try {
      await firstRunner.connect();
      await secondRunner.connect();
      await firstRunner.startTransaction();
      await lockCohostSeatsForMember(firstRunner.manager, MEMBER_ID);

      await secondRunner.startTransaction();
      let isSecondLockHeld = false;
      const secondLock = lockCohostSeatsForMember(
        secondRunner.manager,
        MEMBER_ID,
      ).then(() => {
        isSecondLockHeld = true;
      });

      await waitMilliseconds(300);
      expect(isSecondLockHeld).toBe(false);

      await firstRunner.commitTransaction();
      await secondLock;
      expect(isSecondLockHeld).toBe(true);
      await secondRunner.commitTransaction();
    } finally {
      if (firstRunner.isTransactionActive) {
        await firstRunner.rollbackTransaction();
      }
      if (secondRunner.isTransactionActive) {
        await secondRunner.rollbackTransaction();
      }
      await firstRunner.release();
      await secondRunner.release();
    }
  });
});
