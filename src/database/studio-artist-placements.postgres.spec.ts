// Lives in `src/database` beside the other Postgres specs.
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import {
  PLACEMENT_PAGE_SQL,
  PLACEMENT_TRACKS_SQL,
} from '../studio/studio-artist-placements.service';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import {
  Subprofile,
  SubprofileKind,
  SubprofileStatus,
  SubprofileVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * The Studio dashboard placements queries on real Postgres. Skipped unless
 * `STUDIO_MIGRATIONS_DATABASE_URL` names a database whose name ends in
 * `_test` (it drops and synchronizes the schema from the entities).
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const CREATOR = 'a1000000-0000-4000-8000-000000000001';
const CO_OWNER = 'a1000000-0000-4000-8000-000000000002';
const LISTENER_A = 'a1000000-0000-4000-8000-000000000003';
const LISTENER_B = 'a1000000-0000-4000-8000-000000000004';
const LISTENER_C = 'a1000000-0000-4000-8000-000000000005';
const CREDIT_CREATOR = 'a1000000-0000-4000-8000-000000000006';
const LISTENER_D = 'a1000000-0000-4000-8000-000000000007';
const UNGRANTED_OWNER = 'a1000000-0000-4000-8000-000000000008';
const GRANTED_USERS = [
  CREATOR,
  CO_OWNER,
  LISTENER_A,
  LISTENER_B,
  LISTENER_C,
  CREDIT_CREATOR,
  LISTENER_D,
];

const MUSIC_PERSONA = 'a2000000-0000-4000-8000-000000000001';
const CREDIT_PERSONA = 'a2000000-0000-4000-8000-000000000002';
const QUIET_PERSONA = 'a2000000-0000-4000-8000-000000000003';

const RELEASE_ID = 'a3000000-0000-4000-8000-000000000001';
const OTHER_RELEASE_ID = 'a3000000-0000-4000-8000-000000000002';

const TRACK_IDS = [1, 2, 3, 4, 5, 6, 7].map(
  (trackNumber) => `a4000000-0000-4000-8000-00000000000${trackNumber}`,
);
const [TRACK_1, TRACK_2, TRACK_3, TRACK_4, TRACK_5, TRACK_6, TRACK_7] =
  TRACK_IDS as [string, string, string, string, string, string, string];
const OTHER_TRACK = 'a4000000-0000-4000-8000-000000000099';

// Listed: PUBLIC_D, then CREDITED_C and PUBLIC_A sharing one millisecond
// (by id, highest first), then CREATOR_OWN.
const PUBLIC_A = 'a5000000-0000-4000-8000-000000000001';
const CREATOR_OWN = 'a5000000-0000-4000-8000-000000000003';
const PUBLIC_D = 'a5000000-0000-4000-8000-000000000004';
const PRIVATE_B = 'a5000000-0000-4000-8000-000000000005';
const CONNECTIONS_B = 'a5000000-0000-4000-8000-000000000006';
const CREDITED_C = 'a5000000-0000-4000-8000-000000000007';
const BROKEN_B = 'a5000000-0000-4000-8000-000000000008';
const UNGRANTED = 'a5000000-0000-4000-8000-000000000009';
const EVERY_LISTED = [PUBLIC_D, CREDITED_C, PUBLIC_A, CREATOR_OWN];

interface PageRow {
  playlist_id: string;
  latest_added_at: Date;
  track_count: number;
}

interface TrackRow {
  playlist_id: string;
  track_id: string;
  title: string;
  release_id: string;
}

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

describeWithDatabase('Studio artist placements on real Postgres', () => {
  let dataSource: DataSource;

  const pageOf = (
    cursorTime: Date | null,
    cursorPlaylistId: string | null,
    limit = 21,
  ): Promise<PageRow[]> =>
    dataSource.query(PLACEMENT_PAGE_SQL, [
      MUSIC_PERSONA,
      cursorTime,
      cursorPlaylistId,
      limit,
    ]);

  const listedPlaylistIds = async (): Promise<string[]> =>
    (await pageOf(null, null)).map((row) => row.playlist_id);

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

    await dataSource.getRepository(User).insert(
      [...GRANTED_USERS, UNGRANTED_OWNER].map((userId) => ({
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
    await dataSource.getRepository(Subprofile).insert([
      {
        id: MUSIC_PERSONA,
        userId: CREATOR,
        slug: 'harbour-lights',
        handle: 'harbour-lights',
        displayName: 'Harbour Lights',
        kind: SubprofileKind.Musician,
        status: SubprofileStatus.Published,
        visibility: SubprofileVisibility.Open,
      },
      {
        id: CREDIT_PERSONA,
        userId: CREDIT_CREATOR,
        slug: 'tram-28',
        handle: 'tram-28',
        displayName: 'Tram 28',
        kind: SubprofileKind.Dj,
        status: SubprofileStatus.Published,
        visibility: SubprofileVisibility.Open,
      },
      {
        id: QUIET_PERSONA,
        userId: LISTENER_B,
        slug: 'quiet-hours',
        displayName: 'Quiet Hours',
        kind: SubprofileKind.Dj,
        status: SubprofileStatus.Draft,
        visibility: SubprofileVisibility.Open,
      },
    ]);
    await dataSource.getRepository(SubprofileMember).insert([
      { subprofileId: MUSIC_PERSONA, userId: CREATOR },
      { subprofileId: MUSIC_PERSONA, userId: CO_OWNER },
      { subprofileId: CREDIT_PERSONA, userId: CREDIT_CREATOR },
      { subprofileId: CREDIT_PERSONA, userId: LISTENER_C },
      { subprofileId: QUIET_PERSONA, userId: LISTENER_B },
    ]);
    await dataSource.query(
      `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type", "status", "published_at")
       VALUES ($1, $2, 'Low tide', 'album', 'published', now()),
              ($3, $4, 'Tram at dawn', 'mix', 'published', now())`,
      [RELEASE_ID, MUSIC_PERSONA, OTHER_RELEASE_ID, CREDIT_PERSONA],
    );
    for (const [trackIndex, trackId] of TRACK_IDS.entries()) {
      await dataSource.query(
        `INSERT INTO "studio_tracks" ("id", "release_id", "position", "title", "audio_key", "duration_seconds")
         VALUES ($1, $2, $3, $4, 'studio-audio/a/b.mp3', 200)`,
        [trackId, RELEASE_ID, trackIndex + 1, `Track ${trackIndex + 1}`],
      );
    }
    await dataSource.query(
      `INSERT INTO "studio_tracks" ("id", "release_id", "position", "title", "audio_key", "duration_seconds")
       VALUES ($1, $2, 1, 'Other persona', 'studio-audio/a/c.mp3', 200)`,
      [OTHER_TRACK, OTHER_RELEASE_ID],
    );
    await dataSource.query(
      `INSERT INTO "studio_playlists"
         ("id", "user_id", "name", "visibility", "credit_subprofile_id", "is_credited_to_persona")
       VALUES ($1, $9, 'Public A', 'public', NULL, false),
              ($2, $10, 'Creator own', 'public', NULL, false),
              ($3, $11, 'Public D', 'public', NULL, false),
              ($4, $12, 'Private B', 'private', NULL, false),
              ($5, $12, 'Connections B', 'connections', NULL, false),
              ($6, $13, 'Credited C', 'public', $15, true),
              ($7, $12, 'Broken B', 'public', $16, true),
              ($8, $14, 'Ungranted', 'public', NULL, false)`,
      [
        PUBLIC_A,
        CREATOR_OWN,
        PUBLIC_D,
        PRIVATE_B,
        CONNECTIONS_B,
        CREDITED_C,
        BROKEN_B,
        UNGRANTED,
        LISTENER_A,
        CREATOR,
        LISTENER_D,
        LISTENER_B,
        LISTENER_C,
        UNGRANTED_OWNER,
        CREDIT_PERSONA,
        QUIET_PERSONA,
      ],
    );
    const entries: [string, string, number, string][] = [
      // PUBLIC_A: its latest persona addition holds microseconds; the later
      // entry belongs to another persona and counts for nothing.
      [PUBLIC_A, TRACK_1, 1, '2026-10-20T08:00:00.123789Z'],
      [PUBLIC_A, OTHER_TRACK, 2, '2026-10-22T09:00:00.000Z'],
      [CREDITED_C, TRACK_3, 1, '2026-10-20T08:00:00.123456Z'],
      [CREATOR_OWN, TRACK_2, 1, '2026-10-19T08:00:00.000Z'],
      // PUBLIC_D: seven persona tracks; position 4 stays free for the
      // duplicate entry the tracks test adds.
      [PUBLIC_D, TRACK_6, 1, '2026-10-21T10:00:00.000500Z'],
      [PUBLIC_D, OTHER_TRACK, 2, '2026-10-23T10:00:00.000Z'],
      [PUBLIC_D, TRACK_2, 3, '2026-10-21T09:00:00.000Z'],
      [PUBLIC_D, TRACK_4, 5, '2026-10-21T09:00:00.000Z'],
      [PUBLIC_D, TRACK_1, 6, '2026-10-21T09:00:00.000Z'],
      [PUBLIC_D, TRACK_5, 7, '2026-10-21T09:00:00.000Z'],
      [PUBLIC_D, TRACK_3, 8, '2026-10-21T09:00:00.000Z'],
      [PUBLIC_D, TRACK_7, 9, '2026-10-21T09:00:00.000Z'],
      // Never listed, and newest of all, so a leak would lead the page.
      [PRIVATE_B, TRACK_1, 1, '2026-10-24T08:00:00.000Z'],
      [CONNECTIONS_B, TRACK_1, 1, '2026-10-24T08:00:00.000Z'],
      [BROKEN_B, TRACK_1, 1, '2026-10-24T08:00:00.000Z'],
      [UNGRANTED, TRACK_1, 1, '2026-10-24T08:00:00.000Z'],
    ];
    for (const [playlistId, trackId, position, addedAt] of entries) {
      await dataSource.query(
        `INSERT INTO "studio_playlist_tracks" ("playlist_id", "track_id", "position", "added_at")
         VALUES ($1, $2, $3, $4::timestamptz)`,
        [playlistId, trackId, position, addedAt],
      );
    }
  }, 120000);

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('lists a public playlist holding the persona track, newest addition first', async () => {
    const rows = await pageOf(null, null);

    expect(rows.map((row) => row.playlist_id)).toEqual(EVERY_LISTED);
    const publicRow = rows.find((row) => row.playlist_id === PUBLIC_A);
    expect(publicRow?.latest_added_at).toEqual(
      new Date('2026-10-20T08:00:00.123Z'),
    );
    expect(publicRow?.track_count).toBe(1);
  });

  it('lists a playlist the persona creator owns', async () => {
    const rows = await pageOf(null, null);

    const creatorRow = rows.find((row) => row.playlist_id === CREATOR_OWN);
    expect(creatorRow).toEqual({
      playlist_id: CREATOR_OWN,
      latest_added_at: new Date('2026-10-19T08:00:00.000Z'),
      track_count: 1,
    });
  });

  it('leaves out private, connections and broken-credit playlists', async () => {
    const heldEntries: { playlist_id: string }[] = await dataSource.query(
      `SELECT DISTINCT "playlist_id" FROM "studio_playlist_tracks"
        WHERE "track_id" = $1 ORDER BY "playlist_id"`,
      [TRACK_1],
    );
    // Each of them holds the persona track.
    expect(heldEntries.map((row) => row.playlist_id)).toEqual(
      expect.arrayContaining([PRIVATE_B, CONNECTIONS_B, BROKEN_B, UNGRANTED]),
    );

    const listed = await listedPlaylistIds();

    expect(listed).toEqual(EVERY_LISTED);
    for (const hiddenPlaylistId of [
      PRIVATE_B,
      CONNECTIONS_B,
      BROKEN_B,
      UNGRANTED,
    ]) {
      expect(listed).not.toContain(hiddenPlaylistId);
    }
  });

  it('leaves out a playlist whose owner a co-owner blocked, and one whose owner blocked a co-owner', async () => {
    await withBlocks(
      [
        [CO_OWNER, LISTENER_A],
        [LISTENER_D, CO_OWNER],
      ],
      async () => {
        expect(await listedPlaylistIds()).toEqual([CREDITED_C, CREATOR_OWN]);
      },
    );
    expect(await listedPlaylistIds()).toEqual(EVERY_LISTED);
  });

  it('leaves out a playlist whose owner blocked, or was blocked by, a creator who holds no member row', async () => {
    await dataSource.query(
      `DELETE FROM "subprofile_members" WHERE "subprofile_id" = $1 AND "user_id" = $2`,
      [MUSIC_PERSONA, CREATOR],
    );
    try {
      await withBlocks(
        [
          [LISTENER_A, CREATOR],
          [CREATOR, LISTENER_D],
        ],
        async () => {
          expect(await listedPlaylistIds()).toEqual([CREDITED_C, CREATOR_OWN]);
        },
      );
    } finally {
      await dataSource.getRepository(SubprofileMember).insert({
        subprofileId: MUSIC_PERSONA,
        userId: CREATOR,
      });
    }
  });

  it('leaves out a playlist credited to a persona whose creator a co-owner blocked', async () => {
    // The member-credited playlists read a NULL credit creator and stay.
    await withBlocks([[CO_OWNER, CREDIT_CREATOR]], async () => {
      expect(await listedPlaylistIds()).toEqual([
        PUBLIC_D,
        PUBLIC_A,
        CREATOR_OWN,
      ]);
    });
    await withBlocks([[CREDIT_CREATOR, CO_OWNER]], async () => {
      expect(await listedPlaylistIds()).toEqual([
        PUBLIC_D,
        PUBLIC_A,
        CREATOR_OWN,
      ]);
    });
    expect(await listedPlaylistIds()).toEqual(EVERY_LISTED);
  });

  it('pages by latest addition then id with no row twice or missing', async () => {
    const walked: string[] = [];
    let cursorTime: Date | null = null;
    let cursorPlaylistId: string | null = null;
    const pageSizes: number[] = [];
    for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
      const rows = await pageOf(cursorTime, cursorPlaylistId, 2);
      pageSizes.push(rows.length);
      if (!rows.length) {
        break;
      }
      walked.push(...rows.map((row) => row.playlist_id));
      const lastRow = rows[rows.length - 1]!;
      cursorTime = new Date(lastRow.latest_added_at);
      cursorPlaylistId = lastRow.playlist_id;
    }

    // The page boundary falls between the two playlists sharing a
    // millisecond, whose stored times differ in microseconds.
    expect(pageSizes).toEqual([2, 2, 0]);
    expect(walked).toEqual(EVERY_LISTED);
    expect(new Set(walked).size).toBe(walked.length);
  });

  it('lists each track once at its first position, at most five, and counts them all', async () => {
    // The schema keeps one entry per track; the queries still read a
    // duplicate entry as one track, so the constraint steps aside here.
    await dataSource.query(
      `ALTER TABLE "studio_playlist_tracks" DROP CONSTRAINT "UQ_studio_playlist_tracks_playlist_track"`,
    );
    try {
      await dataSource.query(
        `INSERT INTO "studio_playlist_tracks" ("playlist_id", "track_id", "position", "added_at")
         VALUES ($1, $2, 4, '2026-10-01T08:00:00.000Z'::timestamptz)`,
        [PUBLIC_D, TRACK_6],
      );

      const pageRows = await pageOf(null, null);
      const publicDRow = pageRows.find((row) => row.playlist_id === PUBLIC_D);
      expect(publicDRow).toEqual({
        playlist_id: PUBLIC_D,
        latest_added_at: new Date('2026-10-21T10:00:00.000Z'),
        track_count: 7,
      });

      const trackRows: TrackRow[] = await dataSource.query(
        PLACEMENT_TRACKS_SQL,
        [MUSIC_PERSONA, [PUBLIC_D, PUBLIC_A], 5],
      );
      const trackIdsOf = (playlistId: string) =>
        trackRows
          .filter((row) => row.playlist_id === playlistId)
          .map((row) => row.track_id);

      expect(trackIdsOf(PUBLIC_D)).toEqual([
        TRACK_6,
        TRACK_2,
        TRACK_4,
        TRACK_1,
        TRACK_5,
      ]);
      expect(trackIdsOf(PUBLIC_A)).toEqual([TRACK_1]);
      expect(trackRows.find((row) => row.track_id === TRACK_6)).toEqual({
        playlist_id: PUBLIC_D,
        track_id: TRACK_6,
        title: 'Track 6',
        release_id: RELEASE_ID,
      });
    } finally {
      await dataSource.query(
        `DELETE FROM "studio_playlist_tracks" WHERE "playlist_id" = $1 AND "position" = 4`,
        [PUBLIC_D],
      );
      await dataSource.query(
        `ALTER TABLE "studio_playlist_tracks" ADD CONSTRAINT "UQ_studio_playlist_tracks_playlist_track" UNIQUE ("playlist_id", "track_id")`,
      );
    }
  });
});
