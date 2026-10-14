// Lives in `src/database` beside the other Postgres specs.
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import {
  RELEASE_NOTICE_RECIPIENTS_SQL,
  ReleaseNoticeRecipientRow,
} from '../studio/studio-release-notices.listener';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import {
  Subprofile,
  SubprofileKind,
  SubprofileStatus,
  SubprofileVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * The Studio takedown notice recipients on real Postgres. Skipped unless
 * `STUDIO_MIGRATIONS_DATABASE_URL` names a database whose name ends in
 * `_test` (it drops and synchronizes the schema from the entities).
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const CREATOR = 'b1000000-0000-4000-8000-000000000001';
const CO_OWNER = 'b1000000-0000-4000-8000-000000000002';
const FOLLOWER = 'b1000000-0000-4000-8000-000000000003';
const SOLO_CREATOR = 'b1000000-0000-4000-8000-000000000004';
const SHARED_PERSONA = 'b2000000-0000-4000-8000-000000000001';
const SOLO_PERSONA = 'b2000000-0000-4000-8000-000000000002';
const SHARED_RELEASE = 'b3000000-0000-4000-8000-000000000001';
const SOLO_RELEASE = 'b3000000-0000-4000-8000-000000000002';
const MISSING_RELEASE = 'b3000000-0000-4000-8000-000000000009';

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

describeWithDatabase(
  'Studio takedown notice recipients on real Postgres',
  () => {
    let dataSource: DataSource;

    const recipientsOf = async (
      releaseId: string,
    ): Promise<ReleaseNoticeRecipientRow[]> =>
      dataSource.query(RELEASE_NOTICE_RECIPIENTS_SQL, [releaseId]);

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
      await dataSource.getRepository(User).insert(
        [CREATOR, CO_OWNER, FOLLOWER, SOLO_CREATOR].map((userId) => ({
          id: userId,
          googleId: `google-${userId}`,
          email: `${userId}@example.test`,
          status: UserStatus.Active,
        })),
      );
      await dataSource.getRepository(Subprofile).insert([
        {
          id: SHARED_PERSONA,
          userId: CREATOR,
          slug: 'night-shift',
          handle: 'night-shift',
          displayName: 'Night Shift',
          kind: SubprofileKind.Dj,
          status: SubprofileStatus.Published,
          visibility: SubprofileVisibility.Open,
        },
        {
          id: SOLO_PERSONA,
          userId: SOLO_CREATOR,
          slug: 'quiet-hours',
          handle: 'quiet-hours',
          displayName: 'Quiet Hours',
          kind: SubprofileKind.Musician,
          status: SubprofileStatus.Published,
          visibility: SubprofileVisibility.Open,
        },
      ]);
      // The solo persona's creator holds no roster row on purpose: the
      // creator is reached through `subprofiles.user_id` either way.
      await dataSource.getRepository(SubprofileMember).insert([
        { subprofileId: SHARED_PERSONA, userId: CREATOR },
        { subprofileId: SHARED_PERSONA, userId: CO_OWNER },
      ]);
      await dataSource.query(
        `INSERT INTO "subprofile_followers" ("subprofile_id", "follower_id") VALUES ($1, $2)`,
        [SHARED_PERSONA, FOLLOWER],
      );
      await dataSource.query(
        `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type", "status", "published_at", "taken_down_at")
       VALUES ($1, $3, 'Lisbon at four', 'mix', 'taken_down', now(), now()),
              ($2, $4, 'Kept close', 'single', 'taken_down', now(), now())`,
        [SHARED_RELEASE, SOLO_RELEASE, SHARED_PERSONA, SOLO_PERSONA],
      );
    }, 120000);

    afterAll(async () => {
      await dataSource?.destroy();
    });

    it('reaches the creator and every co-owner once each, and leaves followers out', async () => {
      expect(await recipientsOf(SHARED_RELEASE)).toEqual([
        { release_title: 'Lisbon at four', user_id: CREATOR },
        { release_title: 'Lisbon at four', user_id: CO_OWNER },
      ]);
    });

    it('reaches a creator who holds no roster row', async () => {
      expect(await recipientsOf(SOLO_RELEASE)).toEqual([
        { release_title: 'Kept close', user_id: SOLO_CREATOR },
      ]);
    });

    it('finds nobody for a release that does not exist', async () => {
      expect(await recipientsOf(MISSING_RELEASE)).toEqual([]);
    });
  },
);
