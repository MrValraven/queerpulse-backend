// Lives in `src/database` beside the other Postgres specs.
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import {
  LISTENING_TOTALS_SQL,
  RECENT_LISTENS_SQL,
  TOP_ARTISTS_SQL,
  TOP_TRACKS_SQL,
} from '../studio/studio-listening-history.service';
import { STUDIO_ARTIST_PERSONA_KINDS } from '../studio/studio.constants';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import {
  Subprofile,
  SubprofileKind,
  SubprofileStatus,
  SubprofileVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * The listening history reads on real Postgres. Skipped unless
 * `STUDIO_MIGRATIONS_DATABASE_URL` names a database whose name ends in
 * `_test` (it drops and synchronizes the schema from the entities).
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const LISTENER = 'b1000000-0000-4000-8000-000000000001';
const CREATOR = 'b1000000-0000-4000-8000-000000000002';
const CO_OWNER = 'b1000000-0000-4000-8000-000000000003';
const CREDIT_CREATOR = 'b1000000-0000-4000-8000-000000000004';
const OTHER_CREATOR = 'b1000000-0000-4000-8000-000000000005';
const OTHER_LISTENER = 'b1000000-0000-4000-8000-000000000006';
const EVERY_USER = [
  LISTENER,
  CREATOR,
  CO_OWNER,
  CREDIT_CREATOR,
  OTHER_CREATOR,
  OTHER_LISTENER,
];

// Ids rise in this order, so the id tiebreak reads A, B, D, E.
const ARTIST_A = 'b2000000-0000-4000-8000-000000000001';
const ARTIST_B = 'b2000000-0000-4000-8000-000000000002';
const OTHER_KIND_PERSONA = 'b2000000-0000-4000-8000-000000000003';
const ARTIST_D = 'b2000000-0000-4000-8000-000000000004';
const ARTIST_E = 'b2000000-0000-4000-8000-000000000005';

const RELEASE_A = 'b3000000-0000-4000-8000-000000000001';
const RELEASE_B = 'b3000000-0000-4000-8000-000000000002';
const RELEASE_OTHER_KIND = 'b3000000-0000-4000-8000-000000000003';
const RELEASE_D = 'b3000000-0000-4000-8000-000000000004';
const RELEASE_E = 'b3000000-0000-4000-8000-000000000005';

const TRACK_A1 = 'b4000000-0000-4000-8000-000000000001';
const TRACK_A2 = 'b4000000-0000-4000-8000-000000000002';
const TRACK_A_SILENT = 'b4000000-0000-4000-8000-000000000003';
const TRACK_B1 = 'b4000000-0000-4000-8000-000000000004';
const TRACK_OTHER_KIND = 'b4000000-0000-4000-8000-000000000005';
const TRACK_D1 = 'b4000000-0000-4000-8000-000000000006';
const TRACK_E1 = 'b4000000-0000-4000-8000-000000000007';

const DAY_MS = 24 * 60 * 60 * 1000;

interface TotalsRow {
  total_listens: number;
  listening_days: number;
}

interface TopArtistRow {
  artist_id: string;
  listen_count: number;
}

interface TopTrackRow {
  track_id: string;
  listen_count: number;
}

interface RecentRow {
  id: string;
  track_id: string;
  played_at: Date;
}

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

/** A moment `days` days before now, at the same time of day. */
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

describeWithDatabase('Studio listening history on real Postgres', () => {
  let dataSource: DataSource;

  const insertListens = async (
    userId: string,
    listens: [string, Date][],
  ): Promise<void> => {
    for (const [trackId, playedAt] of listens) {
      await dataSource.query(
        `INSERT INTO "studio_listens" ("user_id", "track_id", "played_at") VALUES ($1, $2, $3)`,
        [userId, trackId, playedAt],
      );
    }
  };

  const insertCredit = (
    trackId: string,
    subprofileId: string,
    role: string,
    status: 'pending' | 'accepted' | 'declined',
  ): Promise<unknown> =>
    dataSource.query(
      `INSERT INTO "studio_persona_credits"
         ("track_id", "subprofile_id", "role", "status", "requested_by_subprofile_id")
       SELECT $1, $2, $3, $4, "release"."subprofile_id"
         FROM "studio_tracks" "track"
        INNER JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
        WHERE "track"."id" = $1`,
      [trackId, subprofileId, role, status],
    );

  const insertBlock = (
    blockerId: string,
    blockedId: string,
  ): Promise<unknown> =>
    dataSource.query(
      `INSERT INTO "blocks" ("blocker_id", "blocked_id") VALUES ($1, $2)`,
      [blockerId, blockedId],
    );

  const totalsOf = async (interval = '28 days'): Promise<TotalsRow[]> =>
    dataSource.query(LISTENING_TOTALS_SQL, [LISTENER, interval]);

  const topArtistsOf = async (
    interval = '28 days',
  ): Promise<[string, number][]> => {
    const rows: TopArtistRow[] = await dataSource.query(TOP_ARTISTS_SQL, [
      LISTENER,
      interval,
      [...STUDIO_ARTIST_PERSONA_KINDS],
      10,
    ]);
    return rows.map((row) => [row.artist_id, row.listen_count]);
  };

  const topTracksOf = async (
    interval = '28 days',
  ): Promise<[string, number][]> => {
    const rows: TopTrackRow[] = await dataSource.query(TOP_TRACKS_SQL, [
      LISTENER,
      interval,
      10,
    ]);
    return rows.map((row) => [row.track_id, row.listen_count]);
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
      EVERY_USER.map((userId) => ({
        id: userId,
        googleId: `google-${userId}`,
        email: `${userId}@example.test`,
        status: UserStatus.Active,
      })),
    );
    const personaOf = (
      id: string,
      userId: string,
      handle: string,
      displayName: string,
      kind: SubprofileKind,
    ) => ({
      id,
      userId,
      slug: handle,
      handle,
      displayName,
      kind,
      status: SubprofileStatus.Published,
      visibility: SubprofileVisibility.Open,
    });
    await dataSource
      .getRepository(Subprofile)
      .insert([
        personaOf(
          ARTIST_A,
          CREATOR,
          'harbour-lights',
          'Harbour Lights',
          SubprofileKind.Musician,
        ),
        personaOf(
          ARTIST_B,
          CREDIT_CREATOR,
          'tram-28',
          'Tram 28',
          SubprofileKind.Dj,
        ),
        personaOf(
          OTHER_KIND_PERSONA,
          OTHER_CREATOR,
          'code-garden',
          'Code Garden',
          SubprofileKind.Developer,
        ),
        personaOf(
          ARTIST_D,
          OTHER_CREATOR,
          'night-stage',
          'Night Stage',
          SubprofileKind.Performer,
        ),
        personaOf(
          ARTIST_E,
          OTHER_CREATOR,
          'river-verses',
          'River Verses',
          SubprofileKind.Dancer,
        ),
      ]);
    // ARTIST_A's creator holds a member row and so does the co-owner.
    await dataSource.getRepository(SubprofileMember).insert([
      { subprofileId: ARTIST_A, userId: CREATOR },
      { subprofileId: ARTIST_A, userId: CO_OWNER },
      { subprofileId: ARTIST_B, userId: CREDIT_CREATOR },
    ]);
    await dataSource.query(
      `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type", "status", "published_at")
       VALUES ($1, $2, 'Low tide', 'album', 'published', now()),
              ($3, $4, 'Tram at dawn', 'album', 'published', now()),
              ($5, $6, 'Commit log', 'album', 'published', now()),
              ($7, $8, 'Late set', 'album', 'published', now()),
              ($9, $10, 'Riverbank', 'album', 'published', now())`,
      [
        RELEASE_A,
        ARTIST_A,
        RELEASE_B,
        ARTIST_B,
        RELEASE_OTHER_KIND,
        OTHER_KIND_PERSONA,
        RELEASE_D,
        ARTIST_D,
        RELEASE_E,
        ARTIST_E,
      ],
    );
    const tracks: [string, string, number, string | null][] = [
      [TRACK_A1, RELEASE_A, 1, 'studio-audio/a/1.mp3'],
      [TRACK_A2, RELEASE_A, 2, 'studio-audio/a/2.mp3'],
      // No audio in place, so nobody can play it.
      [TRACK_A_SILENT, RELEASE_A, 3, null],
      [TRACK_B1, RELEASE_B, 1, 'studio-audio/b/1.mp3'],
      [TRACK_OTHER_KIND, RELEASE_OTHER_KIND, 1, 'studio-audio/c/1.mp3'],
      [TRACK_D1, RELEASE_D, 1, 'studio-audio/d/1.mp3'],
      [TRACK_E1, RELEASE_E, 1, 'studio-audio/e/1.mp3'],
    ];
    for (const [trackId, releaseId, position, audioKey] of tracks) {
      await dataSource.query(
        `INSERT INTO "studio_tracks" ("id", "release_id", "position", "title", "audio_key", "duration_seconds")
         VALUES ($1, $2, $3, $4, $5, 200)`,
        [trackId, releaseId, position, `Track ${position}`, audioKey],
      );
    }
  }, 120000);

  beforeEach(async () => {
    await dataSource.query(`DELETE FROM "studio_listens"`);
    await dataSource.query(`DELETE FROM "studio_persona_credits"`);
    await dataSource.query(`DELETE FROM "blocks"`);
    await dataSource.query(
      `UPDATE "subprofiles" SET "visibility" = 'open' WHERE "id" = $1`,
      [ARTIST_B],
    );
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('counts a listen once for each persona in the attribution set', async () => {
    await insertCredit(TRACK_A1, ARTIST_B, 'featured', 'accepted');
    await insertListens(LISTENER, [
      [TRACK_A1, daysAgo(2)],
      [TRACK_A1, daysAgo(1)],
    ]);

    expect(await topArtistsOf()).toEqual([
      [ARTIST_A, 2],
      [ARTIST_B, 2],
    ]);
    expect(await totalsOf()).toEqual([{ total_listens: 2, listening_days: 2 }]);
  });

  it('gives a persona credited twice on one track the listen once', async () => {
    await insertCredit(TRACK_A1, ARTIST_B, 'featured', 'accepted');
    await insertCredit(TRACK_A1, ARTIST_B, 'producer', 'accepted');
    await insertListens(LISTENER, [[TRACK_A1, daysAgo(1)]]);

    expect(await topArtistsOf()).toEqual([
      [ARTIST_A, 1],
      [ARTIST_B, 1],
    ]);
  });

  it('picks up earlier listens once a credit is accepted', async () => {
    await insertCredit(TRACK_A1, ARTIST_B, 'featured', 'pending');
    await insertListens(LISTENER, [
      [TRACK_A1, daysAgo(3)],
      [TRACK_A1, daysAgo(2)],
    ]);

    expect(await topArtistsOf()).toEqual([[ARTIST_A, 2]]);

    await dataSource.query(
      `UPDATE "studio_persona_credits" SET "status" = 'accepted' WHERE "track_id" = $1 AND "subprofile_id" = $2`,
      [TRACK_A1, ARTIST_B],
    );

    expect(await topArtistsOf()).toEqual([
      [ARTIST_A, 2],
      [ARTIST_B, 2],
    ]);
  });

  it('leaves out a pending or declined credit', async () => {
    await insertCredit(TRACK_A1, ARTIST_B, 'featured', 'pending');
    await insertCredit(TRACK_A2, ARTIST_B, 'producer', 'declined');
    await insertListens(LISTENER, [
      [TRACK_A1, daysAgo(2)],
      [TRACK_A2, daysAgo(1)],
    ]);

    expect(await topArtistsOf()).toEqual([[ARTIST_A, 2]]);
  });

  it('leaves out an artist behind a block with any co-owner, a hidden persona and a persona of another kind', async () => {
    await insertListens(LISTENER, [
      [TRACK_A1, daysAgo(3)],
      [TRACK_B1, daysAgo(2)],
      [TRACK_OTHER_KIND, daysAgo(1)],
    ]);

    // The persona of another kind never appears.
    expect(await topArtistsOf()).toEqual([
      [ARTIST_B, 1],
      [ARTIST_A, 1],
    ]);

    await insertBlock(LISTENER, CO_OWNER);
    expect(await topArtistsOf()).toEqual([[ARTIST_B, 1]]);
    await dataSource.query(`DELETE FROM "blocks"`);

    await insertBlock(CO_OWNER, LISTENER);
    expect(await topArtistsOf()).toEqual([[ARTIST_B, 1]]);
    await dataSource.query(`DELETE FROM "blocks"`);

    await dataSource.query(
      `UPDATE "subprofiles" SET "visibility" = 'private' WHERE "id" = $1`,
      [ARTIST_B],
    );
    expect(await topArtistsOf()).toEqual([[ARTIST_A, 1]]);

    // Every listen still counts in the totals.
    expect(await totalsOf()).toEqual([{ total_listens: 3, listening_days: 3 }]);
  });

  it('orders top artists by listens, then latest listen, then id', async () => {
    await insertCredit(TRACK_B1, ARTIST_D, 'featured', 'accepted');
    await insertListens(LISTENER, [
      // ARTIST_E: the most listens, all of them older.
      [TRACK_E1, daysAgo(10)],
      [TRACK_E1, daysAgo(9)],
      // ARTIST_A: one listen, the newest.
      [TRACK_A1, daysAgo(1)],
      // ARTIST_B and ARTIST_D share this one listen, so the id decides.
      [TRACK_B1, daysAgo(2)],
    ]);

    expect(await topArtistsOf()).toEqual([
      [ARTIST_E, 2],
      [ARTIST_A, 1],
      [ARTIST_B, 1],
      [ARTIST_D, 1],
    ]);
  });

  it('counts distinct UTC days', async () => {
    const midnight = new Date(daysAgo(3).toISOString().slice(0, 10));
    await insertListens(LISTENER, [
      [TRACK_A1, new Date(midnight.getTime() - 1)],
      [TRACK_A1, midnight],
      [TRACK_A1, new Date(midnight.getTime() + 60 * 60 * 1000)],
    ]);

    const playedAt: { played_at: Date }[] = await dataSource.query(
      `SELECT "played_at" FROM "studio_listens" ORDER BY "played_at" ASC`,
    );
    expect(playedAt.map((row) => row.played_at.toISOString())).toEqual([
      new Date(midnight.getTime() - 1).toISOString(),
      midnight.toISOString(),
      new Date(midnight.getTime() + 60 * 60 * 1000).toISOString(),
    ]);
    expect(await totalsOf()).toEqual([{ total_listens: 3, listening_days: 2 }]);
  });

  it('leaves listens outside the window out', async () => {
    await insertListens(LISTENER, [
      [TRACK_A1, daysAgo(27)],
      [TRACK_A1, daysAgo(29)],
      [TRACK_A1, daysAgo(7 * 31)],
    ]);
    // Another member's listen never reaches the caller's reads.
    await insertListens(OTHER_LISTENER, [[TRACK_A1, daysAgo(1)]]);

    expect(await totalsOf('28 days')).toEqual([
      { total_listens: 1, listening_days: 1 },
    ]);
    expect(await topArtistsOf('28 days')).toEqual([[ARTIST_A, 1]]);
    expect(await topTracksOf('28 days')).toEqual([[TRACK_A1, 1]]);

    expect(await totalsOf('6 months')).toEqual([
      { total_listens: 2, listening_days: 2 },
    ]);
    expect(await topArtistsOf('6 months')).toEqual([[ARTIST_A, 2]]);

    expect(await totalsOf('12 months')).toEqual([
      { total_listens: 3, listening_days: 3 },
    ]);
    expect(await topTracksOf('12 months')).toEqual([[TRACK_A1, 3]]);
  });

  it('keeps top tracks to tracks the caller can play', async () => {
    await insertListens(LISTENER, [
      [TRACK_A_SILENT, daysAgo(5)],
      [TRACK_A_SILENT, daysAgo(4)],
      [TRACK_A_SILENT, daysAgo(3)],
      [TRACK_A1, daysAgo(3)],
      [TRACK_A1, daysAgo(2)],
      [TRACK_B1, daysAgo(1)],
    ]);

    expect(await topTracksOf()).toEqual([
      [TRACK_A1, 2],
      [TRACK_B1, 1],
    ]);

    await insertBlock(CREDIT_CREATOR, LISTENER);
    expect(await topTracksOf()).toEqual([[TRACK_A1, 2]]);
    await dataSource.query(`DELETE FROM "blocks"`);

    await dataSource.query(
      `UPDATE "subprofiles" SET "visibility" = 'private' WHERE "id" = $1`,
      [ARTIST_B],
    );
    expect(await topTracksOf()).toEqual([[TRACK_A1, 2]]);
  });

  it('pages recent listens with two rows in one millisecond, none twice or missing', async () => {
    const sharedMillisecond = daysAgo(2);
    const listens: [string, string, Date][] = [
      ['b5000000-0000-4000-8000-000000000001', TRACK_A1, daysAgo(1)],
      ['b5000000-0000-4000-8000-000000000002', TRACK_B1, sharedMillisecond],
      ['b5000000-0000-4000-8000-000000000003', TRACK_A2, sharedMillisecond],
      ['b5000000-0000-4000-8000-000000000004', TRACK_A1, daysAgo(3)],
      ['b5000000-0000-4000-8000-000000000005', TRACK_E1, daysAgo(4)],
    ];
    for (const [listenId, trackId, playedAt] of listens) {
      await dataSource.query(
        `INSERT INTO "studio_listens" ("id", "user_id", "track_id", "played_at") VALUES ($1, $2, $3, $4)`,
        [listenId, LISTENER, trackId, playedAt],
      );
    }
    await insertListens(OTHER_LISTENER, [[TRACK_A1, daysAgo(1)]]);
    // Newest first, and inside the shared millisecond the higher id first.
    const expectedOrder = [
      'b5000000-0000-4000-8000-000000000001',
      'b5000000-0000-4000-8000-000000000003',
      'b5000000-0000-4000-8000-000000000002',
      'b5000000-0000-4000-8000-000000000004',
      'b5000000-0000-4000-8000-000000000005',
    ];

    const walked: string[] = [];
    const pageSizes: number[] = [];
    let cursorTime: Date | null = null;
    let cursorListenId: string | null = null;
    for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
      const rows: RecentRow[] = await dataSource.query(RECENT_LISTENS_SQL, [
        LISTENER,
        cursorTime,
        cursorListenId,
        2,
      ]);
      pageSizes.push(rows.length);
      if (!rows.length) {
        break;
      }
      walked.push(...rows.map((row) => row.id));
      const lastRow = rows[rows.length - 1]!;
      cursorTime = new Date(lastRow.played_at);
      cursorListenId = lastRow.id;
    }

    // The first page ends inside the shared millisecond.
    expect(pageSizes).toEqual([2, 2, 1, 0]);
    expect(walked).toEqual(expectedOrder);
    expect(new Set(walked).size).toBe(walked.length);
  });
});
