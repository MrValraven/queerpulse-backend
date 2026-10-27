// Lives in `src/database` beside the other Postgres specs.
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { StudioPlayMilestonesService } from '../studio/studio-play-milestones.service';
import {
  DAILY_PLAY_UPSERT_SQL,
  LISTEN_INSERT_SQL,
  PLAY_ELIGIBILITY_SQL,
} from '../studio/studio-plays.service';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import {
  Subprofile,
  SubprofileKind,
  SubprofileStatus,
  SubprofileVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * Recording a Studio play on real Postgres: the eligibility read, the daily
 * total upsert, the listen insert and the play milestones. Skipped unless
 * `STUDIO_MIGRATIONS_DATABASE_URL` names a database whose name ends in
 * `_test` (it drops and synchronizes the schema from the entities).
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const CREATOR = 'e1000000-0000-4000-8000-000000000001';
const CO_OWNER = 'e1000000-0000-4000-8000-000000000002';
const CREDIT_CREATOR = 'e1000000-0000-4000-8000-000000000003';
const CREDIT_CO_OWNER = 'e1000000-0000-4000-8000-000000000004';
const PENDING_MEMBER = 'e1000000-0000-4000-8000-000000000005';
const WRITER_CREATOR = 'e1000000-0000-4000-8000-000000000006';
const HIDDEN_CREATOR = 'e1000000-0000-4000-8000-000000000007';
const STRANGER = 'e1000000-0000-4000-8000-000000000008';
const PAUSED_LISTENER = 'e1000000-0000-4000-8000-000000000009';
const GRANTED_USERS = [
  CREATOR,
  CO_OWNER,
  CREDIT_CREATOR,
  CREDIT_CO_OWNER,
  PENDING_MEMBER,
  WRITER_CREATOR,
  HIDDEN_CREATOR,
  STRANGER,
  PAUSED_LISTENER,
];

const MUSIC_PERSONA = 'e2000000-0000-4000-8000-000000000001';
const CREDIT_PERSONA = 'e2000000-0000-4000-8000-000000000002';
const PENDING_PERSONA = 'e2000000-0000-4000-8000-000000000003';
const WRITER_PERSONA = 'e2000000-0000-4000-8000-000000000004';
const PODCAST_PERSONA = 'e2000000-0000-4000-8000-000000000005';
const HIDDEN_PERSONA = 'e2000000-0000-4000-8000-000000000006';

const RELEASE = 'e3000000-0000-4000-8000-000000000001';
const CREDIT_RELEASE = 'e3000000-0000-4000-8000-000000000002';
const WRITER_RELEASE = 'e3000000-0000-4000-8000-000000000003';
const PODCAST_RELEASE = 'e3000000-0000-4000-8000-000000000004';
const DRAFT_RELEASE = 'e3000000-0000-4000-8000-000000000005';
const HIDDEN_RELEASE = 'e3000000-0000-4000-8000-000000000006';

const TRACK = 'e4000000-0000-4000-8000-000000000001';
const PENDING_TRACK = 'e4000000-0000-4000-8000-000000000002';
const WITHHELD_TRACK = 'e4000000-0000-4000-8000-000000000003';
const CREDIT_OWN_TRACK = 'e4000000-0000-4000-8000-000000000004';
const WRITER_TRACK = 'e4000000-0000-4000-8000-000000000005';
const EPISODE_TRACK = 'e4000000-0000-4000-8000-000000000006';
const DRAFT_TRACK = 'e4000000-0000-4000-8000-000000000007';
const HIDDEN_TRACK = 'e4000000-0000-4000-8000-000000000008';

const SEEDED_DAY = '2026-10-01';

interface EligibilityRow {
  is_history_on: boolean;
}

interface MilestoneRow {
  id: string;
  subprofile_id: string;
  kind: string;
  threshold: number;
  track_id: string | null;
  reached_at: Date;
}

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

describeWithDatabase('Studio plays on real Postgres', () => {
  let dataSource: DataSource;
  let milestonesService: StudioPlayMilestonesService;
  let warnSpy: jest.SpyInstance;

  const eligibilityOf = (
    trackId: string,
    callerId: string,
  ): Promise<EligibilityRow[]> =>
    dataSource.query(PLAY_ELIGIBILITY_SQL, [trackId, callerId]);

  const seedDailyPlays = async (
    trackId: string,
    plays: number,
  ): Promise<void> => {
    await dataSource.query(
      `INSERT INTO "studio_track_play_daily" ("track_id", "day", "plays")
       VALUES ($1, $2::date, $3)`,
      [trackId, SEEDED_DAY, plays],
    );
  };

  const milestoneRows = (): Promise<MilestoneRow[]> =>
    dataSource.query(
      `SELECT "id", "subprofile_id", "kind"::text AS "kind", "threshold", "track_id", "reached_at"
         FROM "studio_artist_milestones"
        ORDER BY "kind"::text ASC, "subprofile_id" ASC, "threshold" ASC, "id" ASC`,
    );

  const milestoneSubjects = async (): Promise<
    [string, string, number, string | null][]
  > =>
    (await milestoneRows()).map((row) => [
      row.subprofile_id,
      row.kind,
      row.threshold,
      row.track_id,
    ]);

  const withBlocks = async (
    blockerBlockedPairs: [string, string][],
    check: () => Promise<void>,
  ): Promise<void> => {
    for (const [blockerId, blockedId] of blockerBlockedPairs) {
      await dataSource.query(
        `INSERT INTO "blocks" ("blocker_id", "blocked_id") VALUES ($1, $2)`,
        [blockerId, blockedId],
      );
    }
    try {
      await check();
    } finally {
      await dataSource.query(`DELETE FROM "blocks"`);
    }
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
    // Copied from src/migrations/1837700000000-AddStudioArtistMilestones.ts.
    await dataSource.query(
      `CREATE UNIQUE INDEX "UQ_studio_artist_milestones_subject" ON "studio_artist_milestones"
        ("subprofile_id", "kind", "threshold", COALESCE("track_id", '00000000-0000-0000-0000-000000000000'::uuid))`,
    );
    milestonesService = new StudioPlayMilestonesService(dataSource);

    await dataSource.getRepository(User).insert(
      GRANTED_USERS.map((userId) => ({
        id: userId,
        googleId: `google-${userId}`,
        email: `${userId}@example.test`,
        status: UserStatus.Active,
      })),
    );
    await dataSource.query(
      `INSERT INTO "studio_access_grants" ("user_id") SELECT unnest($1::uuid[])`,
      [GRANTED_USERS],
    );
    const personas: [string, string, string, SubprofileKind][] = [
      [MUSIC_PERSONA, CREATOR, 'harbour-lights', SubprofileKind.Musician],
      [CREDIT_PERSONA, CREDIT_CREATOR, 'tram-28', SubprofileKind.Dj],
      [PENDING_PERSONA, PENDING_MEMBER, 'night-ferry', SubprofileKind.Dj],
      [WRITER_PERSONA, WRITER_CREATOR, 'margin-notes', SubprofileKind.Writer],
      [
        PODCAST_PERSONA,
        CREDIT_CREATOR,
        'kitchen-radio',
        SubprofileKind.Podcaster,
      ],
      [HIDDEN_PERSONA, HIDDEN_CREATOR, 'tucked-away', SubprofileKind.Musician],
    ];
    await dataSource.getRepository(Subprofile).insert(
      personas.map(([personaId, creatorId, handle, kind]) => ({
        id: personaId,
        userId: creatorId,
        slug: handle,
        handle,
        displayName: handle,
        kind,
        status: SubprofileStatus.Published,
        visibility: SubprofileVisibility.Open,
      })),
    );
    await dataSource.getRepository(SubprofileMember).insert([
      { subprofileId: MUSIC_PERSONA, userId: CREATOR },
      { subprofileId: MUSIC_PERSONA, userId: CO_OWNER },
      { subprofileId: CREDIT_PERSONA, userId: CREDIT_CREATOR },
      { subprofileId: CREDIT_PERSONA, userId: CREDIT_CO_OWNER },
      { subprofileId: PENDING_PERSONA, userId: PENDING_MEMBER },
      { subprofileId: WRITER_PERSONA, userId: WRITER_CREATOR },
      { subprofileId: PODCAST_PERSONA, userId: CREDIT_CREATOR },
      { subprofileId: HIDDEN_PERSONA, userId: HIDDEN_CREATOR },
    ]);
    await dataSource.query(
      `INSERT INTO "content_moderation" ("subject_type", "subject_id", "hidden_at")
       VALUES ('subprofile', $1, now())`,
      [HIDDEN_PERSONA],
    );
    await dataSource.query(
      `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type", "status", "published_at")
       VALUES ($1, $2, 'Low tide', 'album', 'published', now()),
              ($3, $4, 'Tram at dawn', 'mix', 'published', now()),
              ($5, $6, 'Margins', 'single', 'published', now()),
              ($7, $8, 'Kitchen radio', 'podcast', 'published', now()),
              ($9, $2, 'Unfinished', 'single', 'draft', NULL),
              ($10, $11, 'Tucked away', 'single', 'published', now())`,
      [
        RELEASE,
        MUSIC_PERSONA,
        CREDIT_RELEASE,
        CREDIT_PERSONA,
        WRITER_RELEASE,
        WRITER_PERSONA,
        PODCAST_RELEASE,
        PODCAST_PERSONA,
        DRAFT_RELEASE,
        HIDDEN_RELEASE,
        HIDDEN_PERSONA,
      ],
    );
    const tracks: [string, string, number][] = [
      [TRACK, RELEASE, 1],
      [PENDING_TRACK, RELEASE, 2],
      [WITHHELD_TRACK, RELEASE, 3],
      [CREDIT_OWN_TRACK, CREDIT_RELEASE, 1],
      [WRITER_TRACK, WRITER_RELEASE, 1],
      [EPISODE_TRACK, PODCAST_RELEASE, 1],
      [DRAFT_TRACK, DRAFT_RELEASE, 1],
      [HIDDEN_TRACK, HIDDEN_RELEASE, 1],
    ];
    for (const [trackId, releaseId, position] of tracks) {
      await dataSource.query(
        `INSERT INTO "studio_tracks" ("id", "release_id", "position", "title", "audio_key", "duration_seconds")
         VALUES ($1, $2, $3, $4, 'studio-audio/a/b.mp3', 200)`,
        [trackId, releaseId, position, `Track ${position}`],
      );
    }
    await dataSource.query(
      `UPDATE "studio_tracks" SET "withheld_at" = now() WHERE "id" = $1`,
      [WITHHELD_TRACK],
    );
    // A published episode whose time has come: only the podcast rule skips it.
    await dataSource.query(
      `UPDATE "studio_tracks" SET "published_at" = now() - interval '1 day' WHERE "id" = $1`,
      [EPISODE_TRACK],
    );
    await dataSource.query(
      `INSERT INTO "studio_persona_credits" ("track_id", "subprofile_id", "role", "status", "requested_by_subprofile_id")
       VALUES ($1, $2, 'featured', 'accepted', $5),
              ($1, $3, 'featured', 'accepted', $5),
              ($4, $6, 'featured', 'pending', $5)`,
      [
        TRACK,
        CREDIT_PERSONA,
        WRITER_PERSONA,
        PENDING_TRACK,
        MUSIC_PERSONA,
        PENDING_PERSONA,
      ],
    );
  }, 120000);

  beforeEach(() => {
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    await dataSource.query(`DELETE FROM "studio_artist_milestones"`);
    await dataSource.query(`DELETE FROM "studio_track_play_daily"`);
    await dataSource.query(`DELETE FROM "studio_listens"`);
    await dataSource.query(`DELETE FROM "member_preferences"`);
    await dataSource.query(`DELETE FROM "blocks"`);
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('finds a published track of a listenable persona for a granted stranger', async () => {
    expect(await eligibilityOf(TRACK, STRANGER)).toEqual([
      { is_history_on: true },
    ]);
    expect(await eligibilityOf(CREDIT_OWN_TRACK, STRANGER)).toEqual([
      { is_history_on: true },
    ]);
  });

  it('skips the release persona creator, who has no member row', async () => {
    expect(await eligibilityOf(TRACK, CREATOR)).toEqual([]);
    await dataSource.query(
      `DELETE FROM "subprofile_members" WHERE "subprofile_id" = $1 AND "user_id" = $2`,
      [MUSIC_PERSONA, CREATOR],
    );
    try {
      expect(await eligibilityOf(TRACK, CREATOR)).toEqual([]);
      expect(await eligibilityOf(PENDING_TRACK, CREATOR)).toEqual([]);
    } finally {
      await dataSource.getRepository(SubprofileMember).insert({
        subprofileId: MUSIC_PERSONA,
        userId: CREATOR,
      });
    }
  });

  it('skips a co-owner of the release persona', async () => {
    expect(await eligibilityOf(TRACK, CO_OWNER)).toEqual([]);
    expect(await eligibilityOf(PENDING_TRACK, CO_OWNER)).toEqual([]);
  });

  it('skips a co-owner of a persona with an accepted credit on the track', async () => {
    expect(await eligibilityOf(TRACK, CREDIT_CO_OWNER)).toEqual([]);
    expect(await eligibilityOf(TRACK, CREDIT_CREATOR)).toEqual([]);
    // The same member counts on a track their persona holds no credit on.
    expect(await eligibilityOf(PENDING_TRACK, CREDIT_CO_OWNER)).toEqual([
      { is_history_on: true },
    ]);
  });

  it('counts for a member of a persona whose credit is still pending', async () => {
    expect(await eligibilityOf(PENDING_TRACK, PENDING_MEMBER)).toEqual([
      { is_history_on: true },
    ]);
  });

  it('skips a podcast episode, a withheld track, a draft release and a hidden persona', async () => {
    const skipped: Record<string, EligibilityRow[]> = {};
    for (const trackId of [
      EPISODE_TRACK,
      WITHHELD_TRACK,
      DRAFT_TRACK,
      HIDDEN_TRACK,
    ]) {
      skipped[trackId] = await eligibilityOf(trackId, STRANGER);
    }

    expect(skipped).toEqual({
      [EPISODE_TRACK]: [],
      [WITHHELD_TRACK]: [],
      [DRAFT_TRACK]: [],
      [HIDDEN_TRACK]: [],
    });
  });

  it('skips a listener blocked either way with the persona creator', async () => {
    await withBlocks([[STRANGER, CREATOR]], async () => {
      expect(await eligibilityOf(TRACK, STRANGER)).toEqual([]);
    });
    await withBlocks([[CREATOR, STRANGER]], async () => {
      expect(await eligibilityOf(TRACK, STRANGER)).toEqual([]);
    });
    expect(await eligibilityOf(TRACK, STRANGER)).toEqual([
      { is_history_on: true },
    ]);
  });

  it('reads paused history from member_preferences and history on when no row exists', async () => {
    await dataSource.query(
      `INSERT INTO "member_preferences" ("user_id", "is_listening_history_on") VALUES ($1, false), ($2, true)`,
      [PAUSED_LISTENER, CO_OWNER],
    );

    expect(await eligibilityOf(TRACK, PAUSED_LISTENER)).toEqual([
      { is_history_on: false },
    ]);
    expect(await eligibilityOf(TRACK, STRANGER)).toEqual([
      { is_history_on: true },
    ]);
  });

  it('adds plays on one track and day into one row', async () => {
    await dataSource.query(DAILY_PLAY_UPSERT_SQL, [TRACK]);
    await dataSource.query(DAILY_PLAY_UPSERT_SQL, [TRACK]);
    await dataSource.query(DAILY_PLAY_UPSERT_SQL, [CREDIT_OWN_TRACK]);

    const rows: { track_id: string; plays: number; is_utc_today: boolean }[] =
      await dataSource.query(
        `SELECT "track_id", "plays", "day" = (now() AT TIME ZONE 'UTC')::date AS "is_utc_today"
           FROM "studio_track_play_daily"
          ORDER BY "track_id" ASC, "day" ASC`,
      );
    expect(rows).toEqual([
      { track_id: TRACK, plays: 2, is_utc_today: true },
      { track_id: CREDIT_OWN_TRACK, plays: 1, is_utc_today: true },
    ]);
  });

  it('writes a listen for the caller and the track', async () => {
    await dataSource.query(LISTEN_INSERT_SQL, [STRANGER, TRACK]);

    const rows: {
      user_id: string;
      track_id: string;
      has_played_at: boolean;
    }[] = await dataSource.query(
      `SELECT "user_id", "track_id", "played_at" IS NOT NULL AS "has_played_at"
         FROM "studio_listens"`,
    );
    expect(rows).toEqual([
      { user_id: STRANGER, track_id: TRACK, has_played_at: true },
    ]);
  });

  it('writes track and artist milestones for the release persona and the credited artist persona', async () => {
    await seedDailyPlays(TRACK, 1000);

    await milestonesService.recordPlayMilestones(TRACK);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(await milestoneSubjects()).toEqual([
      [MUSIC_PERSONA, 'artist_plays', 1000, null],
      [CREDIT_PERSONA, 'artist_plays', 1000, null],
      [MUSIC_PERSONA, 'track_plays', 100, TRACK],
      [MUSIC_PERSONA, 'track_plays', 500, TRACK],
      [MUSIC_PERSONA, 'track_plays', 1000, TRACK],
      [CREDIT_PERSONA, 'track_plays', 100, TRACK],
      [CREDIT_PERSONA, 'track_plays', 500, TRACK],
      [CREDIT_PERSONA, 'track_plays', 1000, TRACK],
    ]);
  });

  it('counts credited plays toward the credited persona artist total', async () => {
    // The credited persona reaches 1000 only with the credited track's plays.
    await seedDailyPlays(TRACK, 600);
    await seedDailyPlays(CREDIT_OWN_TRACK, 500);

    await milestonesService.recordPlayMilestones(TRACK);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(await milestoneSubjects()).toEqual([
      [CREDIT_PERSONA, 'artist_plays', 1000, null],
      [MUSIC_PERSONA, 'track_plays', 100, TRACK],
      [MUSIC_PERSONA, 'track_plays', 500, TRACK],
      [CREDIT_PERSONA, 'track_plays', 100, TRACK],
      [CREDIT_PERSONA, 'track_plays', 500, TRACK],
    ]);
  });

  it('gives a persona whose credit is still pending nothing', async () => {
    await seedDailyPlays(PENDING_TRACK, 1000);

    await milestonesService.recordPlayMilestones(PENDING_TRACK);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(await milestoneSubjects()).toEqual([
      [MUSIC_PERSONA, 'artist_plays', 1000, null],
      [MUSIC_PERSONA, 'track_plays', 100, PENDING_TRACK],
      [MUSIC_PERSONA, 'track_plays', 500, PENDING_TRACK],
      [MUSIC_PERSONA, 'track_plays', 1000, PENDING_TRACK],
    ]);
  });

  it('writes nothing for a persona of another kind', async () => {
    await seedDailyPlays(WRITER_TRACK, 1000);

    await milestonesService.recordPlayMilestones(WRITER_TRACK);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(await milestoneSubjects()).toEqual([]);
  });

  it('writes each threshold once across two runs and keeps the first reached_at', async () => {
    await seedDailyPlays(TRACK, 1000);

    await milestonesService.recordPlayMilestones(TRACK);
    const firstRows = await milestoneRows();
    await milestonesService.recordPlayMilestones(TRACK);
    const secondRows = await milestoneRows();

    expect(firstRows).toHaveLength(8);
    expect(secondRows).toEqual(firstRows);

    await dataSource.query(
      `UPDATE "studio_track_play_daily" SET "plays" = 5000 WHERE "track_id" = $1`,
      [TRACK],
    );
    await milestonesService.recordPlayMilestones(TRACK);
    const thirdRows = await milestoneRows();

    expect(warnSpy).not.toHaveBeenCalled();
    expect(thirdRows).toHaveLength(10);
    expect(thirdRows).toEqual(expect.arrayContaining(firstRows));
    expect(
      thirdRows
        .filter((row) => !firstRows.some((firstRow) => firstRow.id === row.id))
        .map((row) => [row.subprofile_id, row.kind, row.threshold]),
    ).toEqual([
      [MUSIC_PERSONA, 'track_plays', 5000],
      [CREDIT_PERSONA, 'track_plays', 5000],
    ]);
  });
});
