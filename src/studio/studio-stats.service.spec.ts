import { NotFoundException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { SubprofileFollowersService } from '../subprofiles/subprofile-followers.service';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import {
  StudioRelease,
  StudioReleaseStatus,
  StudioReleaseType,
} from './entities/studio-release.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { StudioOwnershipService } from './studio-ownership.service';
import { StudioStatsService } from './studio-stats.service';

const OWNER_ID = 'a7000000-0000-4000-8000-000000000001';
const PERSONA_ID = 'a8000000-0000-4000-8000-000000000001';
const RELEASE_ID = 'a9000000-0000-4000-8000-000000000001';
const DRAFT_ID = 'a9000000-0000-4000-8000-000000000002';
const SCHEDULED_ID = 'a9000000-0000-4000-8000-000000000003';
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
    coverKey: null,
    releasedOn: null,
    status,
    publishedAt:
      status === StudioReleaseStatus.Published
        ? new Date('2026-10-01T09:00:00.000Z')
        : null,
    updatedAt: new Date('2026-10-02T09:00:00.000Z'),
    takedownReason: null,
  }) as StudioRelease;

const trackRow = (id: string, position: number): StudioTrack =>
  ({
    id,
    releaseId: RELEASE_ID,
    position,
    title: `Track ${position}`,
    audioKey: 'studio-audio/a/b.mp3',
    durationSeconds: 100,
    isExplicit: false,
  }) as StudioTrack;

describe('StudioStatsService', () => {
  let query: jest.Mock;
  let releases: { find: jest.Mock };
  let tracks: { find: jest.Mock };
  let subprofiles: { findOne: jest.Mock };
  let ownership: { isPersonaMember: jest.Mock };
  let followers: { loadFollowerCountsFor: jest.Mock };
  let service: StudioStatsService;

  beforeEach(() => {
    query = jest.fn((sql: string) => {
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
    expect(tracks.find).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
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
});
