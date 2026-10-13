// Lives in `src/database` beside the other Postgres specs.
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import {
  ClaimedReleaseRow,
  RELEASE_ALERT_CLAIM_SQL,
  RELEASE_ALERT_RECIPIENTS_SQL,
} from '../studio/studio-release-alerts.listener';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import {
  Subprofile,
  SubprofileKind,
  SubprofileStatus,
  SubprofileVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * The new-release claim and recipient read on real Postgres. Skipped unless
 * `STUDIO_MIGRATIONS_DATABASE_URL` names a database whose name ends in
 * `_test` (it drops and synchronizes the schema from the entities).
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const OWNER = '91000000-0000-4000-8000-000000000001';
const CO_OWNER = '91000000-0000-4000-8000-000000000002';
const GRANTED_FOLLOWER = '91000000-0000-4000-8000-000000000003';
const UNGRANTED_FOLLOWER = '91000000-0000-4000-8000-000000000004';
const LIVE_PERSONA = '92000000-0000-4000-8000-000000000001';
const QUIET_PERSONA = '92000000-0000-4000-8000-000000000002';
const HANDLELESS_PERSONA = '92000000-0000-4000-8000-000000000003';
const BLANK_NAME_PERSONA = '92000000-0000-4000-8000-000000000004';
const LIVE_RELEASE = '93000000-0000-4000-8000-000000000001';
const QUIET_RELEASE = '93000000-0000-4000-8000-000000000002';
const HANDLELESS_RELEASE = '93000000-0000-4000-8000-000000000003';
const BLANK_NAME_RELEASE = '93000000-0000-4000-8000-000000000004';

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

describeWithDatabase('Studio new-release alert SQL on real Postgres', () => {
  let dataSource: DataSource;

  const followersNotifiedAt = async (
    releaseId: string,
  ): Promise<{ followers_notified_at: Date | null }[]> =>
    dataSource.query(
      `SELECT "followers_notified_at" FROM "studio_releases" WHERE "id" = $1`,
      [releaseId],
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
    await dataSource.getRepository(User).insert(
      [OWNER, CO_OWNER, GRANTED_FOLLOWER, UNGRANTED_FOLLOWER].map((userId) => ({
        id: userId,
        googleId: `google-${userId}`,
        email: `${userId}@example.test`,
        status: UserStatus.Active,
      })),
    );
    await dataSource.query(
      `INSERT INTO "studio_access_grants" ("user_id") VALUES ($1), ($2), ($3)`,
      [OWNER, CO_OWNER, GRANTED_FOLLOWER],
    );
    await dataSource.getRepository(Subprofile).insert([
      {
        id: LIVE_PERSONA,
        userId: OWNER,
        slug: 'night-shift',
        handle: 'night-shift',
        displayName: 'Night Shift',
        kind: SubprofileKind.Dj,
        status: SubprofileStatus.Published,
        visibility: SubprofileVisibility.Open,
      },
      {
        id: QUIET_PERSONA,
        userId: OWNER,
        slug: 'quiet-hours',
        handle: 'quiet-hours',
        displayName: 'Quiet Hours',
        kind: SubprofileKind.Dj,
        status: SubprofileStatus.Published,
        visibility: SubprofileVisibility.Private,
      },
      {
        id: HANDLELESS_PERSONA,
        userId: OWNER,
        slug: 'slug-only',
        handle: null,
        displayName: 'Slug Only',
        kind: SubprofileKind.Dj,
        status: SubprofileStatus.Published,
        visibility: SubprofileVisibility.Open,
      },
      {
        id: BLANK_NAME_PERSONA,
        userId: OWNER,
        slug: 'after-hours-slug',
        handle: 'after-hours',
        displayName: '   ',
        kind: SubprofileKind.Dj,
        status: SubprofileStatus.Published,
        visibility: SubprofileVisibility.Open,
      },
    ]);
    await dataSource.getRepository(SubprofileMember).insert([
      { subprofileId: LIVE_PERSONA, userId: OWNER },
      { subprofileId: LIVE_PERSONA, userId: CO_OWNER },
    ]);
    await dataSource.query(
      `INSERT INTO "subprofile_followers" ("subprofile_id", "follower_id")
       VALUES ($1, $2), ($1, $3), ($1, $4)`,
      [LIVE_PERSONA, CO_OWNER, GRANTED_FOLLOWER, UNGRANTED_FOLLOWER],
    );
    await dataSource.query(
      `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type", "status", "published_at")
       VALUES ($1, $5, 'Lisbon at four', 'mix', 'published', now()),
              ($2, $6, 'Kept close', 'mix', 'published', now()),
              ($3, $7, 'No handle yet', 'mix', 'published', now()),
              ($4, $8, 'Untitled hours', 'mix', 'published', now())`,
      [
        LIVE_RELEASE,
        QUIET_RELEASE,
        HANDLELESS_RELEASE,
        BLANK_NAME_RELEASE,
        LIVE_PERSONA,
        QUIET_PERSONA,
        HANDLELESS_PERSONA,
        BLANK_NAME_PERSONA,
      ],
    );
  }, 120000);

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('claims a release once and returns no row the second time', async () => {
    const first: ClaimedReleaseRow[] = await dataSource.query(
      RELEASE_ALERT_CLAIM_SQL,
      [LIVE_RELEASE],
    );
    const second: ClaimedReleaseRow[] = await dataSource.query(
      RELEASE_ALERT_CLAIM_SQL,
      [LIVE_RELEASE],
    );
    expect(first).toEqual([
      {
        release_id: LIVE_RELEASE,
        release_title: 'Lisbon at four',
        release_type: 'mix',
        subprofile_id: LIVE_PERSONA,
        subprofile_name: 'Night Shift',
        subprofile_slug_or_handle: 'night-shift',
        owner_user_id: OWNER,
      },
    ]);
    expect(second).toEqual([]);
  });

  it('leaves the release of a persona that is not listenable unclaimed', async () => {
    const claimed: ClaimedReleaseRow[] = await dataSource.query(
      RELEASE_ALERT_CLAIM_SQL,
      [QUIET_RELEASE],
    );
    expect(claimed).toEqual([]);
    expect(await followersNotifiedAt(QUIET_RELEASE)).toEqual([
      { followers_notified_at: null },
    ]);
  });

  // `listenablePersonaSql` requires a handle, so a persona with a slug alone
  // has no listening page yet and its release waits unclaimed. The link
  // token still reads `COALESCE(handle, slug)`, so it is never null.
  it('leaves the release of a persona without a handle unclaimed', async () => {
    const claimed: ClaimedReleaseRow[] = await dataSource.query(
      RELEASE_ALERT_CLAIM_SQL,
      [HANDLELESS_RELEASE],
    );
    expect(claimed).toEqual([]);
    expect(await followersNotifiedAt(HANDLELESS_RELEASE)).toEqual([
      { followers_notified_at: null },
    ]);
  });

  it('names a persona with a blank display name by its handle', async () => {
    const claimed: ClaimedReleaseRow[] = await dataSource.query(
      RELEASE_ALERT_CLAIM_SQL,
      [BLANK_NAME_RELEASE],
    );
    expect(claimed).toEqual([
      expect.objectContaining({
        subprofile_name: 'after-hours',
        subprofile_slug_or_handle: 'after-hours',
        release_title: 'Untitled hours',
      }),
    ]);
  });

  it('reads granted followers only, without the creator or a co-owner', async () => {
    const rows: { follower_id: string }[] = await dataSource.query(
      RELEASE_ALERT_RECIPIENTS_SQL,
      [LIVE_PERSONA, OWNER, 5000],
    );
    expect(rows).toEqual([{ follower_id: GRANTED_FOLLOWER }]);
  });
});
