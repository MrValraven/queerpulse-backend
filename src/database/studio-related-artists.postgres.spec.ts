// Lives in `src/database` beside the other Postgres specs.
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { RELATED_ARTISTS_SQL } from '../studio/studio-related-artists.service';
import {
  Subprofile,
  SubprofileKind,
  SubprofileStatus,
  SubprofileVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * Related-artist scoring on real Postgres. Skipped unless
 * `STUDIO_MIGRATIONS_DATABASE_URL` names a database whose name ends in
 * `_test` (it drops and synchronizes the schema):
 *
 *   STUDIO_MIGRATIONS_DATABASE_URL=postgres://postgres@127.0.0.1:55450/studio_test \
 *     npx jest src/database/studio-related-artists.postgres.spec.ts
 *
 * The cast, each scored against ARTIST:
 * - PLAYLIST_MATE: two public playlists from two curators (4), newest release.
 * - CREDITED_FRIEND: one accepted credit on ARTIST's track (4).
 * - SCENE_MATE: the same active scene (2) and the same genre (1).
 * - GENRE_ONLY: the same genre (1).
 * - SOLO_CURATOR_MATE: two public playlists from one curator (0).
 * - PENDING_ONLY: a pending credit (0).
 * - BLOCKED_MATE: an accepted credit (4), creator blocked by the viewer.
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const VIEWER = '81000000-0000-4000-8000-000000000001';
const ARTIST_OWNER = '81000000-0000-4000-8000-000000000002';
const BLOCKED_OWNER = '81000000-0000-4000-8000-000000000003';
const CURATOR_ONE = '81000000-0000-4000-8000-000000000004';
const CURATOR_TWO = '81000000-0000-4000-8000-000000000005';

const ARTIST = '82000000-0000-4000-8000-000000000001';
const PLAYLIST_MATE = '82000000-0000-4000-8000-000000000002';
const CREDITED_FRIEND = '82000000-0000-4000-8000-000000000003';
const SCENE_MATE = '82000000-0000-4000-8000-000000000004';
const GENRE_ONLY = '82000000-0000-4000-8000-000000000005';
const SOLO_CURATOR_MATE = '82000000-0000-4000-8000-000000000006';
const PENDING_ONLY = '82000000-0000-4000-8000-000000000007';
const BLOCKED_MATE = '82000000-0000-4000-8000-000000000008';

const SCENE_ID = '83000000-0000-4000-8000-000000000001';

/** One release and one playable track per persona, same suffix. */
const releaseOf = (personaId: string): string => `84${personaId.slice(2)}`;
const trackOf = (personaId: string): string => `85${personaId.slice(2)}`;

const EVERY_PERSONA: [string, string, SubprofileKind, string][] = [
  [ARTIST, 'artist', SubprofileKind.Dj, ARTIST_OWNER],
  [PLAYLIST_MATE, 'playlist-mate', SubprofileKind.Musician, ARTIST_OWNER],
  [CREDITED_FRIEND, 'credited-friend', SubprofileKind.Musician, ARTIST_OWNER],
  [SCENE_MATE, 'scene-mate', SubprofileKind.Dj, ARTIST_OWNER],
  [GENRE_ONLY, 'genre-only', SubprofileKind.Dj, ARTIST_OWNER],
  [SOLO_CURATOR_MATE, 'solo-curator-mate', SubprofileKind.Dj, ARTIST_OWNER],
  [PENDING_ONLY, 'pending-only', SubprofileKind.Dj, ARTIST_OWNER],
  [BLOCKED_MATE, 'blocked-mate', SubprofileKind.Dj, BLOCKED_OWNER],
];

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

describeWithDatabase('RELATED_ARTISTS_SQL on real Postgres', () => {
  let dataSource: DataSource;

  const relatedIds = async (): Promise<string[]> => {
    const rows: { artist_id: string }[] = await dataSource.query(
      RELATED_ARTISTS_SQL,
      [VIEWER, ARTIST, 8],
    );
    return rows.map((row) => row.artist_id);
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

    const everyUser = [
      VIEWER,
      ARTIST_OWNER,
      BLOCKED_OWNER,
      CURATOR_ONE,
      CURATOR_TWO,
    ];
    await dataSource.getRepository(User).insert(
      everyUser.map((userId) => ({
        id: userId,
        googleId: `google-${userId}`,
        email: `${userId}@example.test`,
        status: UserStatus.Active,
      })),
    );
    await dataSource.query(
      `INSERT INTO "studio_access_grants" ("user_id") VALUES ($1), ($2), ($3)`,
      [VIEWER, CURATOR_ONE, CURATOR_TWO],
    );
    await dataSource.getRepository(Subprofile).insert(
      EVERY_PERSONA.map(([personaId, handle, kind, ownerId]) => ({
        id: personaId,
        userId: ownerId,
        slug: handle,
        handle,
        displayName: handle,
        kind,
        status: SubprofileStatus.Published,
        visibility: SubprofileVisibility.Open,
      })),
    );
    await dataSource.query(
      `INSERT INTO "studio_scenes" ("id", "slug", "name", "city", "position")
       VALUES ($1, 'lisbon-ballroom', 'Lisbon ballroom', 'Lisbon', 1)`,
      [SCENE_ID],
    );
    const genreOf = (personaId: string): string =>
      [ARTIST, SCENE_MATE, GENRE_ONLY].includes(personaId)
        ? 'electronic'
        : 'jazz';
    const publishedAtOf = (personaId: string): string =>
      personaId === PLAYLIST_MATE
        ? '2026-10-12T09:00:00.000Z'
        : '2026-10-10T09:00:00.000Z';
    for (const [personaId, handle] of EVERY_PERSONA) {
      await dataSource.query(
        `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type", "status", "published_at", "genre", "scene_id")
         VALUES ($1, $2, $3, 'mix', 'published', $4, $5, $6)`,
        [
          releaseOf(personaId),
          personaId,
          `Release of ${handle}`,
          publishedAtOf(personaId),
          genreOf(personaId),
          [ARTIST, SCENE_MATE].includes(personaId) ? SCENE_ID : null,
        ],
      );
      await dataSource.query(
        `INSERT INTO "studio_tracks" ("id", "release_id", "position", "title", "audio_key", "duration_seconds")
         VALUES ($1, $2, 1, 'Opening', $3, 200)`,
        [
          trackOf(personaId),
          releaseOf(personaId),
          `studio-audio/${personaId}/track.mp3`,
        ],
      );
    }
    // CREDITED_FRIEND and BLOCKED_MATE are credited on ARTIST's track and
    // accepted; PENDING_ONLY waits.
    await dataSource.query(
      `INSERT INTO "studio_persona_credits"
         ("track_id", "subprofile_id", "role", "status", "requested_by_subprofile_id")
       VALUES ($1, $2, 'producer', 'accepted', $5),
              ($1, $3, 'producer', 'accepted', $5),
              ($1, $4, 'producer', 'pending', $5)`,
      [trackOf(ARTIST), CREDITED_FRIEND, BLOCKED_MATE, PENDING_ONLY, ARTIST],
    );
    await dataSource.query(
      `INSERT INTO "blocks" ("blocker_id", "blocked_id") VALUES ($1, $2)`,
      [VIEWER, BLOCKED_OWNER],
    );
    // Playlists: PLAYLIST_MATE beside ARTIST in one list of each curator;
    // SOLO_CURATOR_MATE beside ARTIST in two lists of one curator.
    const playlists: [string, string, string][] = [
      ['86000000-0000-4000-8000-000000000001', CURATOR_ONE, PLAYLIST_MATE],
      ['86000000-0000-4000-8000-000000000002', CURATOR_TWO, PLAYLIST_MATE],
      ['86000000-0000-4000-8000-000000000003', CURATOR_ONE, SOLO_CURATOR_MATE],
      ['86000000-0000-4000-8000-000000000004', CURATOR_ONE, SOLO_CURATOR_MATE],
    ];
    for (const [playlistId, curatorId, personaId] of playlists) {
      await dataSource.query(
        `INSERT INTO "studio_playlists" ("id", "user_id", "name", "visibility")
         VALUES ($1, $2, 'Night bus', 'public')`,
        [playlistId, curatorId],
      );
      await dataSource.query(
        `INSERT INTO "studio_playlist_tracks" ("playlist_id", "track_id", "position")
         VALUES ($1, $2, 1), ($1, $3, 2)`,
        [playlistId, trackOf(ARTIST), trackOf(personaId)],
      );
    }
  }, 120000);

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('ranks by score, then the newest release, and drops every zero score', async () => {
    expect(await relatedIds()).toEqual([
      PLAYLIST_MATE,
      CREDITED_FRIEND,
      SCENE_MATE,
      GENRE_ONLY,
    ]);
  });

  it('counts a playlist pair only when two distinct curators made the lists', async () => {
    expect(await relatedIds()).not.toContain(SOLO_CURATOR_MATE);
  });

  it('leaves out a pending credit and a blocked creator', async () => {
    const ids = await relatedIds();
    expect(ids).not.toContain(PENDING_ONLY);
    expect(ids).not.toContain(BLOCKED_MATE);
  });

  it('drops a related artist whose persona turns private and brings it back when it returns', async () => {
    await dataSource.query(
      `UPDATE "subprofiles" SET "visibility" = 'private' WHERE "id" = $1`,
      [CREDITED_FRIEND],
    );
    expect(await relatedIds()).not.toContain(CREDITED_FRIEND);

    await dataSource.query(
      `UPDATE "subprofiles" SET "visibility" = 'open' WHERE "id" = $1`,
      [CREDITED_FRIEND],
    );
    expect(await relatedIds()).toContain(CREDITED_FRIEND);
  });

  it('stops counting the shared scene once it is archived', async () => {
    await dataSource.query(
      `UPDATE "studio_scenes" SET "status" = 'archived' WHERE "id" = $1`,
      [SCENE_ID],
    );
    const rows: { artist_id: string; score: number }[] = await dataSource.query(
      RELATED_ARTISTS_SQL,
      [VIEWER, ARTIST, 8],
    );
    expect(rows.find((row) => row.artist_id === SCENE_MATE)?.score).toBe(1);
    await dataSource.query(
      `UPDATE "studio_scenes" SET "status" = 'active' WHERE "id" = $1`,
      [SCENE_ID],
    );
  });
});
