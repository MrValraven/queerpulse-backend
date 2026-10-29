// Lives in `src/database`, outside `src/migrations`: the TypeORM CLI and
// `DatabaseModule` require every `src/migrations/*.ts` file.
import { DataSource, QueryRunner } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { RefileMusicFormatEvents1838200100000 } from '../migrations/1838200100000-RefileMusicFormatEvents';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * Music format re-file on real Postgres. Skipped unless
 * `MUSIC_EVENTS_DATABASE_URL` names a database whose name ends in `_test`
 * (it drops and rebuilds the schema). Run it with, for example:
 *
 *   MUSIC_EVENTS_DATABASE_URL=postgres://postgres@127.0.0.1:55450/music_test \
 *     npx jest src/database/music-family-refile.postgres.spec.ts
 *
 * `synchronize` builds the schema from the entities, so the enum already
 * holds `music`; only the re-file migration runs here.
 */
const DATABASE_URL = process.env.MUSIC_EVENTS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const HOST_USER_ID = 'e3000000-0000-4000-8000-000000000001';
const START_AT = '2027-03-01T20:00:00.000Z';

interface InsertedEvent {
  slug: string;
  eventType: string;
  family: string;
  formatDetails: Record<string, unknown> | null;
}

const INSERTED_EVENTS: InsertedEvent[] = [
  {
    slug: 'club-night-party',
    eventType: 'club-night',
    family: 'party',
    formatDetails: { isAdultsOnly: true },
  },
  {
    slug: 'karaoke-party',
    eventType: 'karaoke',
    family: 'party',
    formatDetails: { isSoberFriendly: true },
  },
  {
    slug: 'listening-party-party',
    eventType: 'listening-party',
    family: 'party',
    formatDetails: null,
  },
  {
    slug: 'jam-session-make',
    eventType: 'jam-session',
    family: 'make',
    formatDetails: { bring: 'a drum' },
  },
  {
    slug: 'live-performance-watch',
    eventType: 'live-performance',
    family: 'watch',
    formatDetails: { runtimeMinutes: 75 },
  },
  {
    slug: 'karaoke-meet',
    eventType: 'karaoke',
    family: 'meet',
    formatDetails: null,
  },
  {
    slug: 'supper-club-eat',
    eventType: 'supper-club',
    family: 'eat',
    formatDetails: null,
  },
];

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

describeWithDatabase(
  'RefileMusicFormatEvents1838200100000 on real Postgres',
  () => {
    let dataSource: DataSource;
    let queryRunner: QueryRunner;

    const insertEvent = (inserted: InsertedEvent): Promise<unknown> =>
      dataSource.query(
        `INSERT INTO "events" ("host_id", "slug", "title", "description", "start_at", "timezone", "event_type", "gathering_family", "format_details")
       VALUES ($1::uuid, $2::text, $2::text, $2::text, $3::timestamptz, 'Europe/Lisbon', $4::text, $5::text::"events_gathering_family_enum", $6::jsonb)`,
        [
          HOST_USER_ID,
          inserted.slug,
          START_AT,
          inserted.eventType,
          inserted.family,
          inserted.formatDetails === null
            ? null
            : JSON.stringify(inserted.formatDetails),
        ],
      );

    const readEvents = async (): Promise<
      Pick<InsertedEvent, 'slug' | 'family' | 'formatDetails'>[]
    > => {
      const rows: {
        slug: string;
        family: string;
        format_details: Record<string, unknown> | null;
      }[] = await dataSource.query(
        `SELECT "slug", "gathering_family"::text AS "family", "format_details"
         FROM "events"
        ORDER BY "slug" COLLATE "C" ASC`,
      );
      return rows.map((row) => ({
        slug: row.slug,
        family: row.family,
        formatDetails: row.format_details,
      }));
    };

    const expectedAfterUp = (
      familyBySlug: Record<string, string>,
    ): Pick<InsertedEvent, 'slug' | 'family' | 'formatDetails'>[] =>
      [...INSERTED_EVENTS]
        .sort((first, second) =>
          first.slug < second.slug ? -1 : first.slug > second.slug ? 1 : 0,
        )
        .map((inserted) => ({
          slug: inserted.slug,
          family: familyBySlug[inserted.slug] ?? inserted.family,
          formatDetails: inserted.formatDetails,
        }));

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
      queryRunner = dataSource.createQueryRunner();

      await dataSource.getRepository(User).insert({
        id: HOST_USER_ID,
        googleId: `google-${HOST_USER_ID}`,
        email: `${HOST_USER_ID}@example.test`,
        status: UserStatus.Active,
      });
      await dataSource.query(
        `INSERT INTO "profiles" ("user_id", "slug", "first_name", "last_name")
       VALUES ($1::uuid, 'music-host', 'Music', 'Host')`,
        [HOST_USER_ID],
      );
      for (const inserted of INSERTED_EVENTS) {
        await insertEvent(inserted);
      }
      await new RefileMusicFormatEvents1838200100000().up(queryRunner);
    }, 120000);

    afterAll(async () => {
      await queryRunner?.release();
      await dataSource?.destroy();
    });

    it('moves the five formats from their old families and leaves format_details as stored', async () => {
      const movedSlugs = INSERTED_EVENTS.filter(
        (inserted) =>
          inserted.slug !== 'karaoke-meet' &&
          inserted.slug !== 'supper-club-eat',
      ).map((inserted) => inserted.slug);
      const familyBySlug: Record<string, string> = {};
      for (const slug of movedSlugs) {
        familyBySlug[slug] = 'music';
      }
      const rows = await readEvents();
      expect(rows.filter((row) => row.family === 'music')).toHaveLength(5);
      expect(rows).toEqual(expectedAfterUp(familyBySlug));
    });

    it('leaves a karaoke event filed under another family alone', async () => {
      const rows = await readEvents();
      expect(
        rows
          .filter((row) => row.slug === 'karaoke-meet')
          .map((row) => row.family),
      ).toEqual(['meet']);
    });

    it('leaves every other family untouched', async () => {
      const rows = await readEvents();
      expect(
        rows
          .filter((row) => row.slug === 'supper-club-eat')
          .map((row) => row.family),
      ).toEqual(['eat']);
    });

    it('maps every moved key back on down', async () => {
      await new RefileMusicFormatEvents1838200100000().down(queryRunner);
      const rows = await readEvents();
      expect(rows).toEqual(expectedAfterUp({}));
      expect(
        rows
          .filter((row) => row.family === 'party')
          .map((row) => row.slug)
          .sort(),
      ).toEqual(['club-night-party', 'karaoke-party', 'listening-party-party']);
      expect(rows.filter((row) => row.family === 'make')).toHaveLength(1);
      expect(rows.filter((row) => row.family === 'watch')).toHaveLength(1);
    });
  },
);
