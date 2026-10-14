// Lives in `src/database` beside the other Postgres specs.
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import {
  Connection,
  ConnectionStatus,
} from '../connections/entities/connection.entity';
import { StudioPlaylist } from '../studio/entities/studio-playlist.entity';
import { StudioTrack } from '../studio/entities/studio-track.entity';
import { releasePlaylistCreditsIfPersonaUnlistenable } from '../studio/studio-playlist-credit-release';
import {
  personaCreditActiveSql,
  playableTrackSql,
  playlistOpenToViewerSql,
  publiclyListedPlaylistSql,
} from '../studio/studio-playlist-visibility';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import {
  Subprofile,
  SubprofileKind,
  SubprofileStatus,
  SubprofileVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { User, UserStatus } from '../users/entities/user.entity';

/**
 * Studio v2 playlist visibility predicates on real Postgres. Skipped unless
 * `STUDIO_MIGRATIONS_DATABASE_URL` names a database whose name ends in
 * `_test` (it drops and synchronizes the schema from the entities).
 */
const DATABASE_URL = process.env.STUDIO_MIGRATIONS_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const OWNER = '81000000-0000-4000-8000-000000000001';
const CONNECTION_VIEWER = '81000000-0000-4000-8000-000000000002';
const STRANGER = '81000000-0000-4000-8000-000000000003';
const LIVE_PERSONA = '82000000-0000-4000-8000-000000000001';
const QUIET_PERSONA = '82000000-0000-4000-8000-000000000002';
const RELEASE_ID = '83000000-0000-4000-8000-000000000001';
const PLAYABLE_TRACK = '84000000-0000-4000-8000-000000000001';
const PENDING_TRACK = '84000000-0000-4000-8000-000000000002';
const PUBLIC_MEMBER = '85000000-0000-4000-8000-000000000001';
const PUBLIC_PERSONA = '85000000-0000-4000-8000-000000000002';
const PUBLIC_BROKEN = '85000000-0000-4000-8000-000000000003';
const CONNECTIONS_MEMBER = '85000000-0000-4000-8000-000000000004';
const PRIVATE_MEMBER = '85000000-0000-4000-8000-000000000005';
const CONNECTIONS_PERSONA = '85000000-0000-4000-8000-000000000006';
const EVERY_PLAYLIST = [
  PUBLIC_MEMBER,
  PUBLIC_PERSONA,
  PUBLIC_BROKEN,
  CONNECTIONS_MEMBER,
  PRIVATE_MEMBER,
  CONNECTIONS_PERSONA,
];

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

describeWithDatabase('Studio playlist visibility on real Postgres', () => {
  let dataSource: DataSource;

  const playlistIdsWhere = async (
    predicate: string,
    parameters: Record<string, unknown> = {},
  ): Promise<string[]> => {
    const rows = await dataSource
      .getRepository(StudioPlaylist)
      .createQueryBuilder('playlist')
      .select('"playlist"."id"', 'id')
      .where(predicate, parameters)
      .orderBy('"playlist"."id"', 'ASC')
      .getRawMany<{ id: string }>();
    return rows.map((row) => row.id);
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
      [OWNER, CONNECTION_VIEWER, STRANGER].map((userId) => ({
        id: userId,
        googleId: `google-${userId}`,
        email: `${userId}@example.test`,
        status: UserStatus.Active,
      })),
    );
    await dataSource.query(
      `INSERT INTO "studio_access_grants" ("user_id") VALUES ($1), ($2), ($3)`,
      [OWNER, CONNECTION_VIEWER, STRANGER],
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
        displayName: 'Quiet Hours',
        kind: SubprofileKind.Dj,
        status: SubprofileStatus.Draft,
        visibility: SubprofileVisibility.Open,
      },
    ]);
    await dataSource.getRepository(SubprofileMember).insert([
      { subprofileId: LIVE_PERSONA, userId: OWNER },
      { subprofileId: QUIET_PERSONA, userId: OWNER },
    ]);
    const [userLow, userHigh] = [OWNER, CONNECTION_VIEWER].sort();
    await dataSource.getRepository(Connection).insert({
      requesterId: OWNER,
      addresseeId: CONNECTION_VIEWER,
      userLow,
      userHigh,
      status: ConnectionStatus.Accepted,
    });
    await dataSource.query(
      `INSERT INTO "studio_playlists"
         ("id", "user_id", "name", "visibility", "credit_subprofile_id", "is_credited_to_persona")
       VALUES ($1, $7, 'Public mine', 'public', NULL, false),
              ($2, $7, 'Public as persona', 'public', $8, true),
              ($3, $7, 'Public as quiet persona', 'public', $9, true),
              ($4, $7, 'For connections', 'connections', NULL, false),
              ($5, $7, 'Just mine', 'private', NULL, false),
              ($6, $7, 'Connections as persona', 'connections', $8, true)`,
      [...EVERY_PLAYLIST, OWNER, LIVE_PERSONA, QUIET_PERSONA],
    );
    await dataSource.query(
      `INSERT INTO "studio_releases" ("id", "subprofile_id", "title", "type", "status", "published_at")
       VALUES ($1, $2, 'Lisbon at four', 'mix', 'published', now())`,
      [RELEASE_ID, LIVE_PERSONA],
    );
    await dataSource.query(
      `INSERT INTO "studio_tracks" ("id", "release_id", "position", "title", "audio_key", "duration_seconds")
       VALUES ($1, $3, 1, 'Opening', 'studio-audio/a/b.mp3', 200),
              ($2, $3, 2, 'Still uploading', NULL, NULL)`,
      [PLAYABLE_TRACK, PENDING_TRACK, RELEASE_ID],
    );
  }, 120000);

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('lists public playlists with a standing credit and a granted owner', async () => {
    expect(
      await playlistIdsWhere(publiclyListedPlaylistSql('playlist')),
    ).toEqual([PUBLIC_MEMBER, PUBLIC_PERSONA]);
  });

  it('opens member and persona playlists to a connection by link, private and broken ones excepted', async () => {
    expect(
      await playlistIdsWhere(playlistOpenToViewerSql('playlist', 'viewerId'), {
        viewerId: CONNECTION_VIEWER,
      }),
    ).toEqual([
      PUBLIC_MEMBER,
      PUBLIC_PERSONA,
      CONNECTIONS_MEMBER,
      CONNECTIONS_PERSONA,
    ]);
  });

  it('opens the public ones alone to a member who is no connection', async () => {
    expect(
      await playlistIdsWhere(playlistOpenToViewerSql('playlist', 'viewerId'), {
        viewerId: STRANGER,
      }),
    ).toEqual([PUBLIC_MEMBER, PUBLIC_PERSONA]);
  });

  it('opens every playlist to its owner', async () => {
    expect(
      await playlistIdsWhere(playlistOpenToViewerSql('playlist', 'viewerId'), {
        viewerId: OWNER,
      }),
    ).toEqual(EVERY_PLAYLIST);
  });

  it('hides every playlist from others while the owner holds no grant', async () => {
    await dataSource.query(
      `DELETE FROM "studio_access_grants" WHERE "user_id" = $1`,
      [OWNER],
    );
    expect(
      await playlistIdsWhere(publiclyListedPlaylistSql('playlist')),
    ).toEqual([]);
    expect(
      await playlistIdsWhere(playlistOpenToViewerSql('playlist', 'viewerId'), {
        viewerId: CONNECTION_VIEWER,
      }),
    ).toEqual([]);
    await dataSource.query(
      `INSERT INTO "studio_access_grants" ("user_id") VALUES ($1)`,
      [OWNER],
    );
  });

  it('stops a persona credit from standing once the owner leaves the persona', async () => {
    await dataSource.query(
      `DELETE FROM "subprofile_members" WHERE "subprofile_id" = $1 AND "user_id" = $2`,
      [LIVE_PERSONA, OWNER],
    );
    expect(await playlistIdsWhere(personaCreditActiveSql('playlist'))).toEqual(
      [],
    );
    expect(
      await playlistIdsWhere(publiclyListedPlaylistSql('playlist')),
    ).toEqual([PUBLIC_MEMBER]);
    await dataSource.getRepository(SubprofileMember).insert({
      subprofileId: LIVE_PERSONA,
      userId: OWNER,
    });
    expect(await playlistIdsWhere(personaCreditActiveSql('playlist'))).toEqual([
      PUBLIC_PERSONA,
      CONNECTIONS_PERSONA,
    ]);
  });

  it('stops a persona credit from standing once the persona is no longer a Studio artist kind', async () => {
    await dataSource.query(
      `UPDATE "subprofiles" SET "kind" = 'writer' WHERE "id" = $1`,
      [LIVE_PERSONA],
    );
    expect(await playlistIdsWhere(personaCreditActiveSql('playlist'))).toEqual(
      [],
    );
    await dataSource.query(
      `UPDATE "subprofiles" SET "kind" = 'dj' WHERE "id" = $1`,
      [LIVE_PERSONA],
    );
    expect(await playlistIdsWhere(personaCreditActiveSql('playlist'))).toEqual([
      PUBLIC_PERSONA,
      CONNECTIONS_PERSONA,
    ]);
  });

  it('plays a published track with audio and skips one still uploading', async () => {
    const rows = await dataSource
      .getRepository(StudioTrack)
      .createQueryBuilder('track')
      .innerJoin('track.release', 'release')
      .innerJoin('release.subprofile', 'persona')
      .select('"track"."id"', 'id')
      .where(playableTrackSql('track', 'release', 'persona'))
      .getRawMany<{ id: string }>();
    expect(rows.map((row) => row.id)).toEqual([PLAYABLE_TRACK]);
  });

  it('leaves the credits of a live persona alone and releases them once it goes private', async () => {
    await releasePlaylistCreditsIfPersonaUnlistenable(
      dataSource.manager,
      LIVE_PERSONA,
    );
    expect(await playlistIdsWhere(personaCreditActiveSql('playlist'))).toEqual([
      PUBLIC_PERSONA,
      CONNECTIONS_PERSONA,
    ]);

    await dataSource.query(
      `UPDATE "subprofiles" SET "visibility" = 'private' WHERE "id" = $1`,
      [LIVE_PERSONA],
    );
    await releasePlaylistCreditsIfPersonaUnlistenable(
      dataSource.manager,
      LIVE_PERSONA,
    );
    const released: {
      id: string;
      visibility: string;
      credit_subprofile_id: string | null;
      is_credited_to_persona: boolean;
    }[] = await dataSource.query(
      `SELECT "id", "visibility"::text AS "visibility", "credit_subprofile_id", "is_credited_to_persona"
         FROM "studio_playlists" WHERE "id" = ANY($1::uuid[]) ORDER BY "id"`,
      [[PUBLIC_PERSONA, CONNECTIONS_PERSONA]],
    );
    expect(released).toEqual([
      {
        id: PUBLIC_PERSONA,
        visibility: 'private',
        credit_subprofile_id: null,
        is_credited_to_persona: false,
      },
      {
        id: CONNECTIONS_PERSONA,
        visibility: 'private',
        credit_subprofile_id: null,
        is_credited_to_persona: false,
      },
    ]);
  });
});
