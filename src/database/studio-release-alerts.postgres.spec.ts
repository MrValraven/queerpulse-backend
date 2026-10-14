// Lives in `src/database` beside the other Postgres specs.
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import {
  ClaimedReleaseRow,
  RELEASE_ALERT_CLAIM_SQL,
  RELEASE_ALERT_RECIPIENTS_SQL,
  RELEASE_LATER_DROP_REMINDERS_SQL,
  RELEASE_REMINDERS_DISCARD_SQL,
} from '../studio/studio-release-alerts.listener';
import { INSERT_REMINDER_SQL } from '../studio/studio-release-reminders.service';
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
const REMINDER_HOLDER = '91000000-0000-4000-8000-000000000005';
const UNGRANTED_REMINDER_HOLDER = '91000000-0000-4000-8000-000000000006';
// Studio v3 blocks: the creator blocked the first, the second blocked the
// creator. Both hold a grant, so only the block keeps them out.
const BLOCKED_REMINDER_HOLDER = '91000000-0000-4000-8000-000000000007';
const BLOCKING_REMINDER_HOLDER = '91000000-0000-4000-8000-000000000008';
const SCHEDULED_RELEASE = '93000000-0000-4000-8000-000000000005';
// Claimed by the consume test alone, so it holds whatever order Jest runs in.
const CONSUMED_RELEASE = '93000000-0000-4000-8000-000000000006';
// Studio v3 later drop: published again after its followers already heard.
const LATER_DROP_RELEASE = '93000000-0000-4000-8000-000000000007';
// Studio v3 "Notify me": touched by the reminder insert tests alone, so they
// hold whatever order Jest runs in. The third id is never seeded.
const NOTIFY_SCHEDULED_RELEASE = '93000000-0000-4000-8000-000000000008';
const NOTIFY_PUBLISHED_RELEASE = '93000000-0000-4000-8000-000000000009';
const NOTIFY_MISSING_RELEASE = '93000000-0000-4000-8000-00000000000f';

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

  const reminderHoldersOf = async (releaseId: string): Promise<string[]> => {
    const rows: { user_id: string }[] = await dataSource.query(
      `SELECT "user_id" FROM "studio_release_reminders" WHERE "release_id" = $1 ORDER BY "user_id"`,
      [releaseId],
    );
    return rows.map((row) => row.user_id);
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
    await dataSource.getRepository(User).insert(
      [
        OWNER,
        CO_OWNER,
        GRANTED_FOLLOWER,
        UNGRANTED_FOLLOWER,
        REMINDER_HOLDER,
        UNGRANTED_REMINDER_HOLDER,
        BLOCKED_REMINDER_HOLDER,
        BLOCKING_REMINDER_HOLDER,
      ].map((userId) => ({
        id: userId,
        googleId: `google-${userId}`,
        email: `${userId}@example.test`,
        status: UserStatus.Active,
      })),
    );
    await dataSource.query(
      `INSERT INTO "studio_access_grants" ("user_id") VALUES ($1), ($2), ($3), ($4), ($5), ($6)`,
      [
        OWNER,
        CO_OWNER,
        GRANTED_FOLLOWER,
        REMINDER_HOLDER,
        BLOCKED_REMINDER_HOLDER,
        BLOCKING_REMINDER_HOLDER,
      ],
    );
    await dataSource.query(
      `INSERT INTO "blocks" ("blocker_id", "blocked_id") VALUES ($1, $2), ($3, $1)`,
      [OWNER, BLOCKED_REMINDER_HOLDER, BLOCKING_REMINDER_HOLDER],
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
    await dataSource.query(
      `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type", "status", "publish_at")
       VALUES ($1, $2, 'Still to come', 'mix', 'scheduled', now() + interval '2 days')`,
      [SCHEDULED_RELEASE, LIVE_PERSONA],
    );
    await dataSource.query(
      `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type", "status", "published_at")
       VALUES ($1, $2, 'Second light', 'mix', 'published', now())`,
      [CONSUMED_RELEASE, LIVE_PERSONA],
    );
    await dataSource.query(
      `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type", "status", "published_at", "followers_notified_at")
       VALUES ($1, $2, 'Back again', 'mix', 'published', now(), now() - interval '3 days')`,
      [LATER_DROP_RELEASE, LIVE_PERSONA],
    );
    await dataSource.query(
      `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type", "status", "publish_at")
       VALUES ($1, $2, 'Soon enough', 'mix', 'scheduled', now() + interval '3 days')`,
      [NOTIFY_SCHEDULED_RELEASE, LIVE_PERSONA],
    );
    await dataSource.query(
      `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type", "status", "published_at")
       VALUES ($1, $2, 'Out already', 'mix', 'published', now())`,
      [NOTIFY_PUBLISHED_RELEASE, LIVE_PERSONA],
    );
    await dataSource.query(
      `INSERT INTO "studio_release_reminders" ("release_id", "user_id")
       VALUES ($1, $2), ($1, $3)`,
      [LATER_DROP_RELEASE, REMINDER_HOLDER, BLOCKED_REMINDER_HOLDER],
    );
    await dataSource.query(
      `INSERT INTO "studio_release_reminders" ("release_id", "user_id")
       VALUES ($1, $3), ($1, $4), ($1, $5), ($1, $6), ($2, $3), ($7, $4), ($8, $3), ($8, $6)`,
      [
        LIVE_RELEASE,
        QUIET_RELEASE,
        REMINDER_HOLDER,
        UNGRANTED_REMINDER_HOLDER,
        CO_OWNER,
        GRANTED_FOLLOWER,
        SCHEDULED_RELEASE,
        CONSUMED_RELEASE,
      ],
    );
  }, 120000);

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('claims a release once, consuming its reminders, and returns no row the second time', async () => {
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
        reminder_user_ids: expect.arrayContaining([
          REMINDER_HOLDER,
          UNGRANTED_REMINDER_HOLDER,
          CO_OWNER,
          GRANTED_FOLLOWER,
        ]) as unknown,
      },
    ]);
    expect(first[0]?.reminder_user_ids).toHaveLength(4);
    expect(second).toEqual([]);
  });

  it('consumes the reminders in the claim, so a second claim finds none', async () => {
    const first: ClaimedReleaseRow[] = await dataSource.query(
      RELEASE_ALERT_CLAIM_SQL,
      [CONSUMED_RELEASE],
    );
    expect(first).toHaveLength(1);
    expect([...(first[0]?.reminder_user_ids ?? [])].sort()).toEqual([
      GRANTED_FOLLOWER,
      REMINDER_HOLDER,
    ]);
    expect(await reminderHoldersOf(CONSUMED_RELEASE)).toEqual([]);

    const second: ClaimedReleaseRow[] = await dataSource.query(
      RELEASE_ALERT_CLAIM_SQL,
      [CONSUMED_RELEASE],
    );
    expect(second).toEqual([]);
    expect(await reminderHoldersOf(CONSUMED_RELEASE)).toEqual([]);
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

  it('reads granted followers and granted reminder holders once each, without the creator or a co-owner', async () => {
    const rows: { recipient_id: string; is_reminder_holder: boolean }[] =
      await dataSource.query(RELEASE_ALERT_RECIPIENTS_SQL, [
        LIVE_PERSONA,
        OWNER,
        5000,
        [
          REMINDER_HOLDER,
          UNGRANTED_REMINDER_HOLDER,
          CO_OWNER,
          GRANTED_FOLLOWER,
        ],
      ]);
    expect(rows).toEqual([
      { recipient_id: GRANTED_FOLLOWER, is_reminder_holder: true },
      { recipient_id: REMINDER_HOLDER, is_reminder_holder: true },
    ]);
  });

  it('reads followers alone when nobody set a reminder', async () => {
    const rows: { recipient_id: string; is_reminder_holder: boolean }[] =
      await dataSource.query(RELEASE_ALERT_RECIPIENTS_SQL, [
        LIVE_PERSONA,
        OWNER,
        5000,
        [],
      ]);
    expect(rows).toEqual([
      { recipient_id: GRANTED_FOLLOWER, is_reminder_holder: false },
    ]);
  });

  it('leaves out a reminder holder blocked either way with the creator', async () => {
    const rows: { recipient_id: string; is_reminder_holder: boolean }[] =
      await dataSource.query(RELEASE_ALERT_RECIPIENTS_SQL, [
        LIVE_PERSONA,
        OWNER,
        5000,
        [REMINDER_HOLDER, BLOCKED_REMINDER_HOLDER, BLOCKING_REMINDER_HOLDER],
      ]);
    expect(rows).toEqual([
      { recipient_id: GRANTED_FOLLOWER, is_reminder_holder: false },
      { recipient_id: REMINDER_HOLDER, is_reminder_holder: true },
    ]);
  });

  it('discards the reminders of a published release nobody could be told about', async () => {
    await dataSource.query(RELEASE_REMINDERS_DISCARD_SQL, [QUIET_RELEASE]);
    expect(await reminderHoldersOf(QUIET_RELEASE)).toEqual([]);
  });

  it('consumes a later drop for the unblocked granted reminder holder alone, and a second consume returns nothing', async () => {
    const claimed: ClaimedReleaseRow[] = await dataSource.query(
      RELEASE_ALERT_CLAIM_SQL,
      [LATER_DROP_RELEASE],
    );
    expect(claimed).toEqual([]);

    const first: ClaimedReleaseRow[] = await dataSource.query(
      RELEASE_LATER_DROP_REMINDERS_SQL,
      [LATER_DROP_RELEASE, 5000],
    );
    expect(first).toEqual([
      {
        release_id: LATER_DROP_RELEASE,
        release_title: 'Back again',
        release_type: 'mix',
        subprofile_id: LIVE_PERSONA,
        subprofile_name: 'Night Shift',
        subprofile_slug_or_handle: 'night-shift',
        owner_user_id: OWNER,
        reminder_user_ids: [REMINDER_HOLDER],
      },
    ]);
    expect(await reminderHoldersOf(LATER_DROP_RELEASE)).toEqual([]);

    const second: ClaimedReleaseRow[] = await dataSource.query(
      RELEASE_LATER_DROP_REMINDERS_SQL,
      [LATER_DROP_RELEASE, 5000],
    );
    expect(second).toEqual([]);
  });

  it('leaves the reminders of a scheduled release to wait for its drop', async () => {
    const dropped: ClaimedReleaseRow[] = await dataSource.query(
      RELEASE_LATER_DROP_REMINDERS_SQL,
      [SCHEDULED_RELEASE, 5000],
    );
    expect(dropped).toEqual([]);
    expect(await reminderHoldersOf(SCHEDULED_RELEASE)).toEqual([
      UNGRANTED_REMINDER_HOLDER,
    ]);
  });

  it('keeps the reminders of a release that is still scheduled', async () => {
    await dataSource.query(RELEASE_REMINDERS_DISCARD_SQL, [SCHEDULED_RELEASE]);
    expect(await reminderHoldersOf(SCHEDULED_RELEASE)).toEqual([
      UNGRANTED_REMINDER_HOLDER,
    ]);
  });

  // Studio v3 "Notify me": the insert answers from the locked release, so a
  // repeat press that hits the unique conflict still answers true.
  it('sets a reminder on a scheduled release once, and a second press answers true with one row', async () => {
    const first: { is_set: boolean }[] = await dataSource.query(
      INSERT_REMINDER_SQL,
      [NOTIFY_SCHEDULED_RELEASE, GRANTED_FOLLOWER],
    );
    expect(first).toEqual([{ is_set: true }]);
    expect(await reminderHoldersOf(NOTIFY_SCHEDULED_RELEASE)).toEqual([
      GRANTED_FOLLOWER,
    ]);

    const second: { is_set: boolean }[] = await dataSource.query(
      INSERT_REMINDER_SQL,
      [NOTIFY_SCHEDULED_RELEASE, GRANTED_FOLLOWER],
    );
    expect(second).toEqual([{ is_set: true }]);
    expect(await reminderHoldersOf(NOTIFY_SCHEDULED_RELEASE)).toEqual([
      GRANTED_FOLLOWER,
    ]);
  });

  it('answers false for a published release and writes no reminder', async () => {
    const rows: { is_set: boolean }[] = await dataSource.query(
      INSERT_REMINDER_SQL,
      [NOTIFY_PUBLISHED_RELEASE, GRANTED_FOLLOWER],
    );
    expect(rows).toEqual([{ is_set: false }]);
    expect(await reminderHoldersOf(NOTIFY_PUBLISHED_RELEASE)).toEqual([]);
  });

  it('answers false for a release id that names no release', async () => {
    const rows: { is_set: boolean }[] = await dataSource.query(
      INSERT_REMINDER_SQL,
      [NOTIFY_MISSING_RELEASE, GRANTED_FOLLOWER],
    );
    expect(rows).toEqual([{ is_set: false }]);
    expect(await reminderHoldersOf(NOTIFY_MISSING_RELEASE)).toEqual([]);
  });
});
