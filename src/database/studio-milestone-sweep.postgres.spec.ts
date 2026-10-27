// Lives in `src/database` beside the other Postgres specs.
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { StudioMilestoneSweepService } from '../studio/studio-milestone-sweep.service';
import {
  Subprofile,
  SubprofileKind,
  SubprofileStatus,
  SubprofileVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * The first placement sweep on real Postgres. Skipped unless
 * `STUDIO_MIGRATIONS_DATABASE_URL` names a database whose name ends in
 * `_test` (it drops and synchronizes the schema):
 *
 *   STUDIO_MIGRATIONS_DATABASE_URL=postgres://postgres@127.0.0.1:55450/studio_test \
 *     npx jest src/database/studio-milestone-sweep.postgres.spec.ts
 *
 * The cast, each with one release and one track:
 * - PLACED (dj): on two of a stranger's public playlists, and earlier on
 *   the stranger's private playlist and on its creator's public playlist.
 *   Marked, dated at the earlier of the two public entries.
 * - SELF_PLACED (dj): on a public playlist its creator owns.
 * - CO_OWNER_PLACED (musician): on a public playlist its co-owner owns.
 * - HIDDEN_PLACED (dj): on a stranger's private playlist, a stranger's
 *   connections playlist and a public playlist whose owner holds no grant.
 * - DEVELOPER_PLACED (developer): on a stranger's public playlist.
 * - WITHHELD_PLACED (dj): on a stranger's public playlist, track withheld.
 * - TAKEN_DOWN_PLACED (dj): on a stranger's public playlist, release taken
 *   down.
 *
 * The unique subject index lives in the migration only, so it is created
 * here with the migration's statement after the schema is synchronized.
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const CREATOR = 'cb000000-0000-4000-8000-000000000001';
const CO_OWNER = 'cb000000-0000-4000-8000-000000000002';
const STRANGER = 'cb000000-0000-4000-8000-000000000003';
const OWNER_WITHOUT_GRANT = 'cb000000-0000-4000-8000-000000000004';

const PLACED = 'cb100000-0000-4000-8000-000000000001';
const SELF_PLACED = 'cb100000-0000-4000-8000-000000000002';
const CO_OWNER_PLACED = 'cb100000-0000-4000-8000-000000000003';
const HIDDEN_PLACED = 'cb100000-0000-4000-8000-000000000004';
const DEVELOPER_PLACED = 'cb100000-0000-4000-8000-000000000005';
const WITHHELD_PLACED = 'cb100000-0000-4000-8000-000000000006';
const TAKEN_DOWN_PLACED = 'cb100000-0000-4000-8000-000000000007';

const STRANGER_PUBLIC_PLAYLIST = 'cb400000-0000-4000-8000-000000000001';
const CREATOR_PUBLIC_PLAYLIST = 'cb400000-0000-4000-8000-000000000002';
const CO_OWNER_PUBLIC_PLAYLIST = 'cb400000-0000-4000-8000-000000000003';
const STRANGER_PRIVATE_PLAYLIST = 'cb400000-0000-4000-8000-000000000004';
const STRANGER_CONNECTIONS_PLAYLIST = 'cb400000-0000-4000-8000-000000000005';
const UNGRANTED_PUBLIC_PLAYLIST = 'cb400000-0000-4000-8000-000000000006';
const SECOND_STRANGER_PUBLIC_PLAYLIST = 'cb400000-0000-4000-8000-000000000007';

/** When each of PLACED's entries was added: the earliest two do not count
 *  (a private playlist and a self-placement), so the milestone takes the
 *  second stranger playlist's date. */
const PLACED_ADDED_AT: [string, string][] = [
  [CREATOR_PUBLIC_PLAYLIST, '2026-10-04T10:00:00.000Z'],
  [STRANGER_PRIVATE_PLAYLIST, '2026-10-05T10:00:00.000Z'],
  [SECOND_STRANGER_PUBLIC_PLAYLIST, '2026-10-11T10:00:00.000Z'],
  [STRANGER_PUBLIC_PLAYLIST, '2026-10-12T10:00:00.000Z'],
];
const PLACED_FIRST_QUALIFYING_ADDED_AT = '2026-10-11T10:00:00.000Z';

/** One release and one playable track per persona, same suffix. */
const releaseOf = (personaId: string): string => `cb2${personaId.slice(3)}`;
const trackOf = (personaId: string): string => `cb3${personaId.slice(3)}`;

const EVERY_PERSONA: [string, string, SubprofileKind][] = [
  [PLACED, 'placed', SubprofileKind.Dj],
  [SELF_PLACED, 'self-placed', SubprofileKind.Dj],
  [CO_OWNER_PLACED, 'co-owner-placed', SubprofileKind.Musician],
  [HIDDEN_PLACED, 'hidden-placed', SubprofileKind.Dj],
  [DEVELOPER_PLACED, 'developer-placed', SubprofileKind.Developer],
  [WITHHELD_PLACED, 'withheld-placed', SubprofileKind.Dj],
  [TAKEN_DOWN_PLACED, 'taken-down-placed', SubprofileKind.Dj],
];

/** Playlist id, owner, visibility, and the personas whose tracks it lists. */
const EVERY_PLAYLIST: [string, string, string, string[]][] = [
  [
    STRANGER_PUBLIC_PLAYLIST,
    STRANGER,
    'public',
    [PLACED, DEVELOPER_PLACED, WITHHELD_PLACED, TAKEN_DOWN_PLACED],
  ],
  [CREATOR_PUBLIC_PLAYLIST, CREATOR, 'public', [SELF_PLACED, PLACED]],
  [CO_OWNER_PUBLIC_PLAYLIST, CO_OWNER, 'public', [CO_OWNER_PLACED]],
  [STRANGER_PRIVATE_PLAYLIST, STRANGER, 'private', [HIDDEN_PLACED, PLACED]],
  [STRANGER_CONNECTIONS_PLAYLIST, STRANGER, 'connections', [HIDDEN_PLACED]],
  [UNGRANTED_PUBLIC_PLAYLIST, OWNER_WITHOUT_GRANT, 'public', [HIDDEN_PLACED]],
  [SECOND_STRANGER_PUBLIC_PLAYLIST, STRANGER, 'public', [PLACED]],
];

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

describeWithDatabase('FIRST_PLACEMENT_SWEEP_SQL on real Postgres', () => {
  let dataSource: DataSource;
  let service: StudioMilestoneSweepService;

  const markedPersonaIds = async (): Promise<string[]> => {
    const rows: { subprofile_id: string }[] = await dataSource.query(
      `SELECT "subprofile_id" FROM "studio_artist_milestones"
        WHERE "kind" = 'first_placement' AND "threshold" = 1
        ORDER BY "subprofile_id" ASC`,
    );
    return rows.map((row) => row.subprofile_id);
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
    service = new StudioMilestoneSweepService(dataSource);

    await dataSource.getRepository(User).insert(
      [CREATOR, CO_OWNER, STRANGER, OWNER_WITHOUT_GRANT].map((userId) => ({
        id: userId,
        googleId: `google-${userId}`,
        email: `${userId}@example.test`,
        status: UserStatus.Active,
      })),
    );
    await dataSource.query(
      `INSERT INTO "studio_access_grants" ("user_id") VALUES ($1), ($2), ($3)`,
      [CREATOR, CO_OWNER, STRANGER],
    );
    await dataSource.getRepository(Subprofile).insert(
      EVERY_PERSONA.map(([personaId, handle, kind]) => ({
        id: personaId,
        userId: CREATOR,
        slug: handle,
        handle,
        displayName: handle,
        kind,
        status: SubprofileStatus.Published,
        visibility: SubprofileVisibility.Open,
      })),
    );
    for (const [personaId, handle] of EVERY_PERSONA) {
      await dataSource.query(
        `INSERT INTO "subprofile_members" ("subprofile_id", "user_id") VALUES ($1, $2)`,
        [personaId, CREATOR],
      );
      await dataSource.query(
        `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type", "status", "published_at", "genre")
         VALUES ($1, $2, $3, 'mix', 'published', '2026-10-10T09:00:00.000Z', 'electronic')`,
        [releaseOf(personaId), personaId, `Release of ${handle}`],
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
    await dataSource.query(
      `UPDATE "studio_tracks" SET "withheld_at" = now() WHERE "id" = $1`,
      [trackOf(WITHHELD_PLACED)],
    );
    await dataSource.query(
      `UPDATE "studio_releases"
          SET "status" = 'taken_down', "taken_down_at" = now(), "takedown_reason" = 'Uploaded without the rights'
        WHERE "id" = $1`,
      [releaseOf(TAKEN_DOWN_PLACED)],
    );
    // CO_OWNER co-owns SELF_PLACED and CO_OWNER_PLACED.
    await dataSource.query(
      `INSERT INTO "subprofile_members" ("subprofile_id", "user_id") VALUES ($1, $3), ($2, $3)`,
      [SELF_PLACED, CO_OWNER_PLACED, CO_OWNER],
    );
    for (const [
      playlistId,
      ownerId,
      visibility,
      personaIds,
    ] of EVERY_PLAYLIST) {
      await dataSource.query(
        `INSERT INTO "studio_playlists" ("id", "user_id", "name", "visibility")
         VALUES ($1, $2, 'Night bus', $3)`,
        [playlistId, ownerId, visibility],
      );
      for (const [index, personaId] of personaIds.entries()) {
        await dataSource.query(
          `INSERT INTO "studio_playlist_tracks" ("playlist_id", "track_id", "position")
           VALUES ($1, $2, $3)`,
          [playlistId, trackOf(personaId), index + 1],
        );
      }
    }
    for (const [playlistId, addedAt] of PLACED_ADDED_AT) {
      await dataSource.query(
        `UPDATE "studio_playlist_tracks" SET "added_at" = $3
          WHERE "playlist_id" = $1 AND "track_id" = $2`,
        [playlistId, trackOf(PLACED), addedAt],
      );
    }
  }, 120000);

  beforeEach(async () => {
    await dataSource.query(`DELETE FROM "studio_artist_milestones"`);
    await dataSource.query(
      `UPDATE "studio_playlists" SET "visibility" = 'public' WHERE "id" = $1`,
      [STRANGER_PUBLIC_PLAYLIST],
    );
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it("marks a persona whose track sits on a stranger's public playlist", async () => {
    expect(await service.markFirstPlacements()).toBe(1);
    expect(await markedPersonaIds()).toEqual([PLACED]);
  });

  it('dates the milestone at the earliest qualifying playlist entry', async () => {
    await service.markFirstPlacements();
    const rows: { reached_at: Date }[] = await dataSource.query(
      `SELECT "reached_at" FROM "studio_artist_milestones"
        WHERE "subprofile_id" = $1 AND "kind" = 'first_placement'`,
      [PLACED],
    );
    expect(rows.map((row) => row.reached_at.toISOString())).toEqual([
      PLACED_FIRST_QUALIFYING_ADDED_AT,
    ]);
  });

  it('skips a placement on a playlist the persona creator owns', async () => {
    await service.markFirstPlacements();
    expect(await markedPersonaIds()).not.toContain(SELF_PLACED);
  });

  it('skips a placement on a playlist a co-owner owns', async () => {
    await service.markFirstPlacements();
    expect(await markedPersonaIds()).not.toContain(CO_OWNER_PLACED);
  });

  it('skips a private or connections playlist and an owner without the grant', async () => {
    await service.markFirstPlacements();
    expect(await markedPersonaIds()).not.toContain(HIDDEN_PLACED);
  });

  it('skips a persona of another kind', async () => {
    await service.markFirstPlacements();
    expect(await markedPersonaIds()).not.toContain(DEVELOPER_PLACED);
  });

  it('skips a persona whose only placed track is withheld', async () => {
    await service.markFirstPlacements();
    expect(await markedPersonaIds()).not.toContain(WITHHELD_PLACED);
  });

  it('skips a persona whose placed track sits on a taken down release', async () => {
    await service.markFirstPlacements();
    expect(await markedPersonaIds()).not.toContain(TAKEN_DOWN_PLACED);
  });

  it('writes once across two sweeps and keeps the first reached_at', async () => {
    expect(await service.markFirstPlacements()).toBe(1);
    await dataSource.query(
      `UPDATE "studio_artist_milestones" SET "reached_at" = '2026-10-01T08:00:00.000Z'
        WHERE "subprofile_id" = $1`,
      [PLACED],
    );

    expect(await service.markFirstPlacements()).toBe(0);

    const rows: { reached_at: Date }[] = await dataSource.query(
      `SELECT "reached_at" FROM "studio_artist_milestones" WHERE "subprofile_id" = $1`,
      [PLACED],
    );
    expect(rows.map((row) => row.reached_at.toISOString())).toEqual([
      '2026-10-01T08:00:00.000Z',
    ]);
  });

  it('keeps the milestone when the playlist turns private', async () => {
    await service.markFirstPlacements();
    await dataSource.query(
      `UPDATE "studio_playlists" SET "visibility" = 'private' WHERE "id" = $1`,
      [STRANGER_PUBLIC_PLAYLIST],
    );

    expect(await service.markFirstPlacements()).toBe(0);
    expect(await markedPersonaIds()).toEqual([PLACED]);
  });
});
