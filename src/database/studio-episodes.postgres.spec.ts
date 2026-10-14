// Lives in `src/database` beside the other Postgres specs.
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { EPISODE_ALERT_CLAIM_SQL } from '../studio/studio-episode-alerts.listener';
import { STAMP_SHOW_EPISODES_SQL } from '../studio/studio-episode-rule';
import { playableTrackSql } from '../studio/studio-playlist-visibility';
import { SCHEDULED_RELEASE_CLAIM_SQL } from '../studio/studio-scheduled-releases.service';
import {
  Subprofile,
  SubprofileKind,
  SubprofileStatus,
  SubprofileVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * Studio artist kinds on real Postgres: the playable arm, the show stamp,
 * the stamp at the scheduled drop and the episode alert claim. Skipped
 * unless `STUDIO_MIGRATIONS_DATABASE_URL` names a database whose name ends
 * in `_test` (it drops and synchronizes the schema from the entities).
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const OWNER = 'e6000000-0000-4000-8000-000000000001';
const PERSONA = 'e6100000-0000-4000-8000-000000000001';
const SHOW = 'e6200000-0000-4000-8000-000000000001';
const MIX = 'e6200000-0000-4000-8000-000000000002';
const SCHEDULED_SHOW = 'e6200000-0000-4000-8000-000000000003';
const DRAFT_SHOW = 'e6200000-0000-4000-8000-000000000004';
const RELEASED_EPISODE = 'e6300000-0000-4000-8000-000000000001';
const DRAFT_EPISODE = 'e6300000-0000-4000-8000-000000000002';
const FUTURE_EPISODE = 'e6300000-0000-4000-8000-000000000003';
const UPLOADING_EPISODE = 'e6300000-0000-4000-8000-000000000004';
const MIX_TRACK = 'e6300000-0000-4000-8000-000000000005';
const SCHEDULED_EPISODE = 'e6300000-0000-4000-8000-000000000006';
const UNPUBLISHED_SHOW_EPISODE = 'e6300000-0000-4000-8000-000000000007';
const FIRST_RELEASE_TIME = '2026-10-01T09:00:00.000Z';
const SHOW_PUBLISH_TIME = '2026-10-14T10:00:00.000Z';

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

describeWithDatabase('Studio episode SQL on real Postgres', () => {
  let dataSource: DataSource;

  const episodeOf = async (
    trackId: string,
  ): Promise<{
    published_at: Date | null;
    followers_notified_at: Date | null;
  }> => {
    const rows: {
      published_at: Date | null;
      followers_notified_at: Date | null;
    }[] = await dataSource.query(
      `SELECT "published_at", "followers_notified_at" FROM "studio_tracks" WHERE "id" = $1`,
      [trackId],
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
      slug: 'lisbon-after-dark',
      handle: 'lisbon-after-dark',
      displayName: 'Lisbon After Dark',
      kind: SubprofileKind.Podcaster,
      status: SubprofileStatus.Published,
      visibility: SubprofileVisibility.Open,
    });
    await dataSource.query(
      `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type", "status", "published_at", "publish_at")
       VALUES ($1, $5, 'Lisbon After Dark', 'podcast', 'published', now() - interval '1 day', NULL),
              ($2, $5, 'Night set', 'mix', 'published', now() - interval '1 day', NULL),
              ($3, $5, 'Coming show', 'podcast', 'scheduled', NULL, now() - interval '1 minute'),
              ($4, $5, 'Paused show', 'podcast', 'draft', NULL, NULL)`,
      [SHOW, MIX, SCHEDULED_SHOW, DRAFT_SHOW, PERSONA],
    );
    const tracks: [string, string, number, string | null, string | null][] = [
      [RELEASED_EPISODE, SHOW, 1, 'studio-audio/a/1.mp3', FIRST_RELEASE_TIME],
      [DRAFT_EPISODE, SHOW, 2, 'studio-audio/a/2.mp3', null],
      [
        FUTURE_EPISODE,
        SHOW,
        3,
        'studio-audio/a/3.mp3',
        new Date(Date.now() + 3_600_000).toISOString(),
      ],
      [UPLOADING_EPISODE, SHOW, 4, null, null],
      [MIX_TRACK, MIX, 1, 'studio-audio/a/5.mp3', null],
      [SCHEDULED_EPISODE, SCHEDULED_SHOW, 1, 'studio-audio/a/6.mp3', null],
      [
        UNPUBLISHED_SHOW_EPISODE,
        DRAFT_SHOW,
        1,
        'studio-audio/a/7.mp3',
        FIRST_RELEASE_TIME,
      ],
    ];
    for (const [
      trackId,
      releaseId,
      position,
      audioKey,
      publishedAt,
    ] of tracks) {
      await dataSource.query(
        `INSERT INTO "studio_tracks" ("id", "release_id", "position", "title", "audio_key", "audio_content_type", "duration_seconds", "published_at")
         VALUES ($1, $2, $3, 'Episode', $4, CASE WHEN $4::text IS NULL THEN NULL ELSE 'audio/mpeg' END, CASE WHEN $4::text IS NULL THEN NULL ELSE 1800 END, $5)`,
        [trackId, releaseId, position, audioKey, publishedAt],
      );
    }
  }, 120000);

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('lets the playable predicate through a published episode and a music track only', async () => {
    const rows: { id: string }[] = await dataSource.query(
      `SELECT "track"."id" AS "id"
         FROM "studio_tracks" "track"
         INNER JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
         INNER JOIN "subprofiles" "persona" ON "persona"."id" = "release"."subprofile_id"
        WHERE ${playableTrackSql('track', 'release', 'persona')}
        ORDER BY "track"."id"`,
    );
    expect(rows.map((row) => row.id)).toEqual([RELEASED_EPISODE, MIX_TRACK]);
  });

  it('claims a published episode once and answers the show, the episode and the persona', async () => {
    const first: Record<string, unknown>[] = await dataSource.query(
      EPISODE_ALERT_CLAIM_SQL,
      [RELEASED_EPISODE],
    );
    const second: unknown[] = await dataSource.query(EPISODE_ALERT_CLAIM_SQL, [
      RELEASED_EPISODE,
    ]);
    expect(first).toEqual([
      {
        track_id: RELEASED_EPISODE,
        track_title: 'Episode',
        release_id: SHOW,
        release_title: 'Lisbon After Dark',
        subprofile_id: PERSONA,
        subprofile_name: 'Lisbon After Dark',
        subprofile_slug_or_handle: 'lisbon-after-dark',
        owner_user_id: OWNER,
      },
    ]);
    expect(second).toEqual([]);
  });

  it('claims nothing for a draft episode, a music track or an episode of an unpublished show', async () => {
    for (const trackId of [
      DRAFT_EPISODE,
      MIX_TRACK,
      UNPUBLISHED_SHOW_EPISODE,
    ]) {
      expect(
        await dataSource.query(EPISODE_ALERT_CLAIM_SQL, [trackId]),
      ).toEqual([]);
    }
  });

  it('stamps the episodes with audio and no publish time, with the alert already claimed', async () => {
    await dataSource.query(STAMP_SHOW_EPISODES_SQL, [SHOW, SHOW_PUBLISH_TIME]);
    const draft = await episodeOf(DRAFT_EPISODE);
    expect(draft.published_at?.toISOString()).toBe(SHOW_PUBLISH_TIME);
    expect(draft.followers_notified_at).not.toBeNull();
    expect((await episodeOf(UPLOADING_EPISODE)).published_at).toBeNull();
    expect(
      (await episodeOf(RELEASED_EPISODE)).published_at?.toISOString(),
    ).toBe(FIRST_RELEASE_TIME);
    expect(
      await dataSource.query(EPISODE_ALERT_CLAIM_SQL, [DRAFT_EPISODE]),
    ).toEqual([]);
  });

  it('stamps the episodes of a scheduled show at the drop, so the episode claim finds nothing', async () => {
    const dropped: { release_id: string }[] = await dataSource.query(
      SCHEDULED_RELEASE_CLAIM_SQL,
      [100],
    );
    expect(dropped).toEqual([{ release_id: SCHEDULED_SHOW }]);
    const releaseRows: { published_at: Date }[] = await dataSource.query(
      `SELECT "published_at" FROM "studio_releases" WHERE "id" = $1`,
      [SCHEDULED_SHOW],
    );
    const episode = await episodeOf(SCHEDULED_EPISODE);
    expect(episode.published_at?.toISOString()).toBe(
      releaseRows[0]!.published_at.toISOString(),
    );
    expect(episode.followers_notified_at).not.toBeNull();
    expect(
      await dataSource.query(EPISODE_ALERT_CLAIM_SQL, [SCHEDULED_EPISODE]),
    ).toEqual([]);
  });

  it('keeps the first publish time across an unpublish and a second publish', async () => {
    await dataSource.query(
      `UPDATE "studio_releases" SET "status" = 'draft', "published_at" = NULL WHERE "id" = $1`,
      [SHOW],
    );
    await dataSource.query(
      `UPDATE "studio_releases" SET "status" = 'published', "published_at" = now() WHERE "id" = $1`,
      [SHOW],
    );
    await dataSource.query(STAMP_SHOW_EPISODES_SQL, [
      SHOW,
      '2026-10-20T10:00:00.000Z',
    ]);
    expect(
      (await episodeOf(RELEASED_EPISODE)).published_at?.toISOString(),
    ).toBe(FIRST_RELEASE_TIME);
    expect((await episodeOf(DRAFT_EPISODE)).published_at?.toISOString()).toBe(
      SHOW_PUBLISH_TIME,
    );
  });
});
