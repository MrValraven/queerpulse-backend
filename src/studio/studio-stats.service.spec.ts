import { NotFoundException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { SubprofileFollowersService } from '../subprofiles/subprofile-followers.service';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import {
  StudioPriceMode,
  StudioRelease,
  StudioReleaseStatus,
  StudioReleaseType,
} from './entities/studio-release.entity';
import { StudioCredit, StudioTrack } from './entities/studio-track.entity';
import { StudioOwnershipService } from './studio-ownership.service';
import { StudioArtistStats } from './studio-stats';
import { StudioStatsService } from './studio-stats.service';

const OWNER_ID = 'a7000000-0000-4000-8000-000000000001';
const PERSONA_ID = 'a8000000-0000-4000-8000-000000000001';
const RELEASE_ID = 'a9000000-0000-4000-8000-000000000001';
const DRAFT_ID = 'a9000000-0000-4000-8000-000000000002';
const SCHEDULED_ID = 'a9000000-0000-4000-8000-000000000003';
const TAKEN_DOWN_ID = 'a9000000-0000-4000-8000-000000000004';
const TRACK_ONE = 'aa000000-0000-4000-8000-000000000001';
const TRACK_TWO = 'aa000000-0000-4000-8000-000000000002';

const releaseRow = (id: string, status: StudioReleaseStatus): StudioRelease =>
  ({
    id,
    subprofileId: PERSONA_ID,
    title: `Release ${id.slice(-1)}`,
    type: StudioReleaseType.Mix,
    description: null,
    genre: null,
    genres: [] as string[],
    mood: null,
    buyUrl: null,
    coverKey: null,
    releasedOn: null,
    status,
    publishedAt:
      status === StudioReleaseStatus.Published
        ? new Date('2026-10-01T09:00:00.000Z')
        : null,
    publishAt:
      status === StudioReleaseStatus.Scheduled
        ? new Date('2026-11-02T18:00:00.000Z')
        : null,
    tracksChangedAt: null,
    updatedAt: new Date('2026-10-02T09:00:00.000Z'),
    takedownReason: null,
    priceMode: StudioPriceMode.NotForSale,
    priceCents: null,
  }) as StudioRelease;

const trackRow = (id: string, position: number): StudioTrack => {
  const row: Partial<StudioTrack> = {
    id,
    releaseId: RELEASE_ID,
    position,
    title: `Track ${position}`,
    audioKey: 'studio-audio/a/b.mp3',
    durationSeconds: 100,
    isExplicit: false,
    credits: [] as StudioCredit[],
    lyrics: null,
    syncedLyrics: null,
    withheldAt: null,
  };
  return row as StudioTrack;
};

describe('StudioStatsService', () => {
  let query: jest.Mock;
  let releases: { find: jest.Mock };
  let tracks: { find: jest.Mock };
  let subprofiles: { findOne: jest.Mock };
  let ownership: { isPersonaMember: jest.Mock };
  let followers: { loadFollowerCountsFor: jest.Mock };
  let followerGrowthRows: { week_start: string; new_followers: number }[];
  let versionRows: { release_id: string; latest_created_at: Date }[];
  let playRows: { track_id: string; plays: string; plays_28d: string }[];
  let service: StudioStatsService;

  beforeEach(() => {
    followerGrowthRows = [];
    versionRows = [];
    playRows = [];
    query = jest.fn((sql: string) => {
      if (sql.includes('FROM "studio_track_play_daily"')) {
        return Promise.resolve(playRows);
      }
      if (sql.includes('FROM "subprofile_followers"')) {
        return Promise.resolve(followerGrowthRows);
      }
      if (sql.includes('FROM "studio_release_versions"')) {
        return Promise.resolve(versionRows);
      }
      if (sql.includes('FROM "saved_item"')) {
        return Promise.resolve([
          {
            subject_type: 'studio_release',
            subject_id: RELEASE_ID,
            save_count: 7,
          },
          {
            subject_type: 'studio_track',
            subject_id: TRACK_ONE,
            save_count: 2,
          },
        ]);
      }
      if (sql.includes('GROUP BY "entry"."track_id"')) {
        return Promise.resolve([
          { track_id: TRACK_ONE, inclusion_count: 5 },
          { track_id: TRACK_TWO, inclusion_count: 3 },
        ]);
      }
      if (sql.includes('GROUP BY "track"."release_id"')) {
        return Promise.resolve([
          { release_id: RELEASE_ID, inclusion_count: 6 },
        ]);
      }
      if (sql.includes('FROM "studio_release_reminders"')) {
        return Promise.resolve([
          { release_id: SCHEDULED_ID, reminder_count: 3 },
        ]);
      }
      return Promise.resolve([]);
    });
    releases = {
      find: jest
        .fn()
        .mockResolvedValue([
          releaseRow(DRAFT_ID, StudioReleaseStatus.Draft),
          releaseRow(RELEASE_ID, StudioReleaseStatus.Published),
        ]),
    };
    tracks = {
      find: jest
        .fn()
        .mockResolvedValue([trackRow(TRACK_ONE, 1), trackRow(TRACK_TWO, 2)]),
    };
    subprofiles = {
      findOne: jest.fn().mockResolvedValue({
        id: PERSONA_ID,
        handle: 'night-shift',
        displayName: 'Night Shift',
        kind: 'dj',
        avatarUrl: null,
      }),
    };
    ownership = { isPersonaMember: jest.fn().mockResolvedValue(true) };
    followers = {
      loadFollowerCountsFor: jest
        .fn()
        .mockResolvedValue(new Map([[PERSONA_ID, 3]])),
    };
    service = new StudioStatsService(
      { query } as unknown as DataSource,
      releases as unknown as Repository<StudioRelease>,
      tracks as unknown as Repository<StudioTrack>,
      subprofiles as unknown as Repository<Subprofile>,
      ownership as unknown as StudioOwnershipService,
      followers as unknown as SubprofileFollowersService,
    );
  });

  it('answers 404 to a member who does not run the persona, before reading anything', async () => {
    ownership.isPersonaMember.mockResolvedValue(false);
    await expect(
      service.getArtistStats(OWNER_ID, PERSONA_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(releases.find).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('shows the follower total as is, even below five', async () => {
    const stats = await service.getArtistStats(OWNER_ID, PERSONA_ID);
    expect(stats.subprofileId).toBe(PERSONA_ID);
    expect(stats.followerCount).toBe(3);
  });

  it('echoes the stored persona id when the link carries it in capitals', async () => {
    const stats = await service.getArtistStats(
      OWNER_ID,
      PERSONA_ID.toUpperCase(),
    );
    expect(stats.subprofileId).toBe(PERSONA_ID);
    expect(stats.followerCount).toBe(3);
    expect(followers.loadFollowerCountsFor).toHaveBeenCalledWith([PERSONA_ID]);
  });

  it('lists the published release first and withholds counts from 1 to 4', async () => {
    const stats = await service.getArtistStats(OWNER_ID, PERSONA_ID);

    expect(stats.releases.map((row) => row.release.id)).toEqual([
      RELEASE_ID,
      DRAFT_ID,
    ]);
    const [published, draft] = stats.releases;
    expect(published?.release.status).toBe('published');
    expect(published?.saves).toEqual({ value: 7, isBelowThreshold: false });
    expect(published?.playlistInclusions).toEqual({
      value: 6,
      isBelowThreshold: false,
    });
    expect(
      published?.tracks.map((row) => [
        row.track.id,
        row.saves,
        row.playlistInclusions,
      ]),
    ).toEqual([
      [
        TRACK_ONE,
        { value: null, isBelowThreshold: true },
        { value: 5, isBelowThreshold: false },
      ],
      [
        TRACK_TWO,
        { value: 0, isBelowThreshold: false },
        { value: null, isBelowThreshold: true },
      ],
    ]);
    expect(draft?.saves).toEqual({ value: 0, isBelowThreshold: false });
    expect(draft?.tracks).toEqual([]);
  });

  it('counts saves from saved Studio releases and tracks by id', async () => {
    await service.getArtistStats(OWNER_ID, PERSONA_ID);
    const savesCall = (query.mock.calls as [string, string[][]][]).find(
      ([sql]) => sql.includes('FROM "saved_item"'),
    )!;
    expect(savesCall[0]).toContain(`"saved"."subject_type" = 'studio_release'`);
    expect(savesCall[0]).toContain(`"saved"."subject_type" = 'studio_track'`);
    expect(savesCall[1]).toEqual([
      [RELEASE_ID, DRAFT_ID],
      [TRACK_ONE, TRACK_TWO],
    ]);
  });

  it('counts only playlists that are publicly listed, each playlist once per release', async () => {
    await service.getArtistStats(OWNER_ID, PERSONA_ID);
    const inclusionCalls = query.mock.calls.filter(([sql]) =>
      String(sql).includes('"studio_playlist_tracks"'),
    );
    expect(inclusionCalls).toHaveLength(2);
    for (const [sql] of inclusionCalls) {
      expect(sql).toContain(`"playlist"."visibility" = 'public'`);
      expect(sql).not.toContain(`'connections'`);
      expect(sql).toContain('COUNT(DISTINCT "entry"."playlist_id")');
    }
  });

  it('asks nothing more of a persona with no releases', async () => {
    releases.find.mockResolvedValue([]);
    const stats = await service.getArtistStats(OWNER_ID, PERSONA_ID);
    expect(stats.releases).toEqual([]);
    expect(stats.nextRelease).toBeNull();
    expect(tracks.find).not.toHaveBeenCalled();
    // Studio dashboard: the weekly follower read is the only query left.
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM "subprofile_followers"'),
      expect.anything(),
    );
  });

  // Studio v3: Notify me counts on scheduled releases, under the floor.
  it('counts reminders on scheduled releases only, withholding 1 to 4', async () => {
    releases.find.mockResolvedValue([
      releaseRow(RELEASE_ID, StudioReleaseStatus.Published),
      releaseRow(SCHEDULED_ID, StudioReleaseStatus.Scheduled),
    ]);
    ownership.isPersonaMember.mockResolvedValue(true);

    const stats = await service.getArtistStats(OWNER_ID, PERSONA_ID);

    const byId = new Map(
      stats.releases.map((row) => [row.release.id, row.reminders]),
    );
    expect(byId.get(RELEASE_ID)).toBeNull();
    expect(byId.get(SCHEDULED_ID)).toEqual({
      value: null,
      isBelowThreshold: true,
    });
    const reminderCall = query.mock.calls.find(([sql]: [string]) =>
      sql.includes('FROM "studio_release_reminders"'),
    ) as [string, unknown[]] | undefined;
    expect(reminderCall?.[1]).toEqual([[SCHEDULED_ID]]);
  });

  it('reads no reminders when no release is scheduled', async () => {
    ownership.isPersonaMember.mockResolvedValue(true);

    await service.getArtistStats(OWNER_ID, PERSONA_ID);

    expect(
      query.mock.calls.some(([sql]: [string]) =>
        sql.includes('FROM "studio_release_reminders"'),
      ),
    ).toBe(false);
  });

  // Studio artist kinds: a show gets the release numbers and no per-episode
  // numbers.
  it('lists a show with its counts and no per-episode rows', async () => {
    releases.find.mockResolvedValue([
      {
        ...releaseRow(RELEASE_ID, StudioReleaseStatus.Published),
        type: StudioReleaseType.Podcast,
      },
    ]);

    const stats = await service.getArtistStats(OWNER_ID, PERSONA_ID);

    expect(stats.releases).toHaveLength(1);
    expect(stats.releases[0]?.tracks).toEqual([]);
    expect(stats.releases[0]?.saves).toEqual({
      value: 7,
      isBelowThreshold: false,
    });
    expect(stats.releases[0]?.playlistInclusions).toEqual({
      value: 6,
      isBelowThreshold: false,
    });
  });

  // Studio dashboard: follower weeks, the next release and release health.
  describe('dashboard extras', () => {
    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(new Date('2026-10-28T15:00:00.000Z'));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('reports twelve zero-filled Monday weeks ending with the current week', async () => {
      const stats = await service.getArtistStats(OWNER_ID, PERSONA_ID);
      expect(stats.followerGrowth).toHaveLength(12);
      expect(stats.followerGrowth[0]).toEqual({
        weekStart: '2026-08-10',
        newFollowers: 0,
      });
      expect(stats.followerGrowth[11]).toEqual({
        weekStart: '2026-10-26',
        newFollowers: 0,
      });
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('FROM "subprofile_followers"'),
        [PERSONA_ID, '2026-08-10T00:00:00.000Z'],
      );
    });

    it('reads follower weeks for the stored persona id', async () => {
      await service.getArtistStats(OWNER_ID, PERSONA_ID.toUpperCase());
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('FROM "subprofile_followers"'),
        [PERSONA_ID, '2026-08-10T00:00:00.000Z'],
      );
    });

    it('shows weekly new followers unfloored', async () => {
      followerGrowthRows = [{ week_start: '2026-10-19', new_followers: 2 }];
      const stats = await service.getArtistStats(OWNER_ID, PERSONA_ID);
      expect(stats.followerGrowth[10]).toEqual({
        weekStart: '2026-10-19',
        newFollowers: 2,
      });
    });

    it('names the soonest scheduled release with its floored reminders', async () => {
      releases.find.mockResolvedValue([
        releaseRow(DRAFT_ID, StudioReleaseStatus.Draft),
        releaseRow(RELEASE_ID, StudioReleaseStatus.Published),
        releaseRow(SCHEDULED_ID, StudioReleaseStatus.Scheduled),
      ]);
      const stats = await service.getArtistStats(OWNER_ID, PERSONA_ID);
      expect(stats.nextRelease).toEqual({
        releaseId: SCHEDULED_ID,
        title: 'Release 3',
        publishAt: '2026-11-02T18:00:00.000Z',
        reminders: { value: null, isBelowThreshold: true },
      });
    });

    it('answers a null next release when nothing is scheduled', async () => {
      const stats = await service.getArtistStats(OWNER_ID, PERSONA_ID);
      expect(stats.nextRelease).toBeNull();
    });

    it('puts health on every release row and an empty list on a taken-down one', async () => {
      releases.find.mockResolvedValue([
        releaseRow(DRAFT_ID, StudioReleaseStatus.Draft),
        releaseRow(RELEASE_ID, StudioReleaseStatus.Published),
        releaseRow(SCHEDULED_ID, StudioReleaseStatus.Scheduled),
        releaseRow(TAKEN_DOWN_ID, StudioReleaseStatus.TakenDown),
      ]);
      const stats = await service.getArtistStats(OWNER_ID, PERSONA_ID);
      const rowOf = (releaseId: string) =>
        stats.releases.find((row) => row.release.id === releaseId);
      const fullChecklist = [
        'cover',
        'description',
        'genreAndMood',
        'creditsOnEveryTrack',
        'lyrics',
        'buyLink',
      ];
      expect(rowOf(RELEASE_ID)?.health.map((item) => item.key)).toEqual(
        fullChecklist,
      );
      expect(rowOf(DRAFT_ID)?.health.map((item) => item.key)).toEqual(
        fullChecklist,
      );
      expect(rowOf(SCHEDULED_ID)?.health.map((item) => item.key)).toEqual(
        fullChecklist,
      );
      expect(rowOf(TAKEN_DOWN_ID)?.health).toEqual([]);
    });

    it('reads credits and lyrics from the release tracks', async () => {
      tracks.find.mockResolvedValue([
        {
          ...trackRow(TRACK_ONE, 1),
          credits: [{ role: 'producer', name: 'Ana' }],
          lyrics: 'First line',
        },
        {
          ...trackRow(TRACK_TWO, 2),
          credits: [{ role: 'producer', name: 'Ana' }],
          lyrics: 'Second line',
        },
      ]);
      const stats = await service.getArtistStats(OWNER_ID, PERSONA_ID);
      const published = stats.releases.find(
        (row) => row.release.id === RELEASE_ID,
      );
      expect(
        published?.health.filter(
          (item) => item.key === 'creditsOnEveryTrack' || item.key === 'lyrics',
        ),
      ).toEqual([
        { key: 'creditsOnEveryTrack', isDone: true, isOptional: false },
        { key: 'lyrics', isDone: true, isOptional: true },
      ]);
    });

    it('reads version dates only for published releases with track changes', async () => {
      releases.find.mockResolvedValue([
        {
          ...releaseRow(DRAFT_ID, StudioReleaseStatus.Draft),
          tracksChangedAt: new Date('2026-10-05T09:00:00.000Z'),
        },
        {
          ...releaseRow(RELEASE_ID, StudioReleaseStatus.Published),
          tracksChangedAt: new Date('2026-10-05T09:00:00.000Z'),
        },
      ]);
      const stats = await service.getArtistStats(OWNER_ID, PERSONA_ID);
      const rowOf = (releaseId: string) =>
        stats.releases.find((row) => row.release.id === releaseId);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('FROM "studio_release_versions"'),
        [[RELEASE_ID]],
      );
      expect(rowOf(RELEASE_ID)?.health.at(-1)).toEqual({
        key: 'versionNote',
        isDone: false,
        isOptional: false,
      });
      expect(
        rowOf(DRAFT_ID)?.health.some((item) => item.key === 'versionNote'),
      ).toBe(false);
    });

    it('drops the version note once a version follows the track change', async () => {
      releases.find.mockResolvedValue([
        {
          ...releaseRow(RELEASE_ID, StudioReleaseStatus.Published),
          tracksChangedAt: new Date('2026-10-05T09:00:00.000Z'),
        },
      ]);
      versionRows = [
        {
          release_id: RELEASE_ID,
          latest_created_at: new Date('2026-10-06T09:00:00.000Z'),
        },
      ];
      const stats = await service.getArtistStats(OWNER_ID, PERSONA_ID);
      expect(
        stats.releases[0]?.health.some((item) => item.key === 'versionNote'),
      ).toBe(false);
    });

    it('skips the version read when no published release changed', async () => {
      await service.getArtistStats(OWNER_ID, PERSONA_ID);
      expect(query).not.toHaveBeenCalledWith(
        expect.stringContaining('FROM "studio_release_versions"'),
        expect.anything(),
      );
    });
  });

  // Studio dashboard listening: plays from the anonymous daily totals.
  describe('plays', () => {
    const BELOW = { value: null, isBelowThreshold: true };
    const ZERO = { value: 0, isBelowThreshold: false };

    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(new Date('2026-10-28T15:00:00.000Z'));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    const rowOf = (stats: StudioArtistStats, releaseId: string) =>
      stats.releases.find((row) => row.release.id === releaseId);

    it('reads plays per track from the window start 27 days before today', async () => {
      await service.getArtistStats(OWNER_ID, PERSONA_ID);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('FROM "studio_track_play_daily"'),
        [[TRACK_ONE, TRACK_TWO], '2026-10-01'],
      );
    });

    it('floors each track and sums the release before its own floor', async () => {
      playRows = [
        { track_id: TRACK_ONE, plays: '3', plays_28d: '3' },
        { track_id: TRACK_TWO, plays: '3', plays_28d: '0' },
      ];
      const stats = await service.getArtistStats(OWNER_ID, PERSONA_ID);
      expect(
        rowOf(stats, RELEASE_ID)?.tracks.map((row) => [
          row.plays,
          row.plays28d,
        ]),
      ).toEqual([
        [BELOW, BELOW],
        [BELOW, ZERO],
      ]);
      expect([
        rowOf(stats, RELEASE_ID)?.plays,
        rowOf(stats, RELEASE_ID)?.plays28d,
      ]).toEqual([{ value: 6, isBelowThreshold: false }, BELOW]);
      expect([
        rowOf(stats, DRAFT_ID)?.plays,
        rowOf(stats, DRAFT_ID)?.plays28d,
      ]).toEqual([ZERO, ZERO]);
    });

    it('sums withheld tracks into the release', async () => {
      tracks.find.mockResolvedValue([
        {
          ...trackRow(TRACK_ONE, 1),
          withheldAt: new Date('2026-10-20T09:00:00.000Z'),
        },
        trackRow(TRACK_TWO, 2),
      ]);
      playRows = [
        { track_id: TRACK_ONE, plays: '4', plays_28d: '4' },
        { track_id: TRACK_TWO, plays: '2', plays_28d: '1' },
      ];
      const stats = await service.getArtistStats(OWNER_ID, PERSONA_ID);
      expect([
        rowOf(stats, RELEASE_ID)?.plays,
        rowOf(stats, RELEASE_ID)?.plays28d,
      ]).toEqual([
        { value: 6, isBelowThreshold: false },
        { value: 5, isBelowThreshold: false },
      ]);
      expect(
        rowOf(stats, RELEASE_ID)?.tracks.map((row) => [
          row.track.id,
          row.plays,
        ]),
      ).toEqual([
        [TRACK_ONE, BELOW],
        [TRACK_TWO, BELOW],
      ]);
    });

    it('answers zero plays on a show, whatever its episodes hold', async () => {
      releases.find.mockResolvedValue([
        {
          ...releaseRow(RELEASE_ID, StudioReleaseStatus.Published),
          type: StudioReleaseType.Podcast,
        },
      ]);
      playRows = [
        { track_id: TRACK_ONE, plays: '9', plays_28d: '9' },
        { track_id: TRACK_TWO, plays: '9', plays_28d: '9' },
      ];
      const stats = await service.getArtistStats(OWNER_ID, PERSONA_ID);
      expect([
        rowOf(stats, RELEASE_ID)?.plays,
        rowOf(stats, RELEASE_ID)?.plays28d,
        rowOf(stats, RELEASE_ID)?.tracks,
      ]).toEqual([ZERO, ZERO, []]);
    });

    it('skips the play read when the persona has no tracks', async () => {
      tracks.find.mockResolvedValue([] as StudioTrack[]);
      const stats = await service.getArtistStats(OWNER_ID, PERSONA_ID);
      expect(
        query.mock.calls.some(([sql]: [string]) =>
          sql.includes('FROM "studio_track_play_daily"'),
        ),
      ).toBe(false);
      expect(
        stats.releases.map((row) => [row.release.id, row.plays, row.plays28d]),
      ).toEqual([
        [RELEASE_ID, ZERO, ZERO],
        [DRAFT_ID, ZERO, ZERO],
      ]);
    });
  });
});
