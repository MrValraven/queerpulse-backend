import {
  artistPlayMilestoneThresholdsUpTo,
  followerMilestoneThresholdsUpTo,
  trackPlayMilestoneThresholdsUpTo,
  toStudioMilestone,
  type StudioMilestoneRow,
} from './studio-milestones';

const MILESTONE_ID = '11111111-1111-4111-8111-111111111111';
const PERSONA_ID = '22222222-2222-4222-8222-222222222222';
const TRACK_ID = '33333333-3333-4333-8333-333333333333';

const followerRow: StudioMilestoneRow = {
  id: MILESTONE_ID,
  subprofile_id: PERSONA_ID,
  kind: 'followers',
  threshold: '100',
  reached_at: new Date('2026-10-20T08:00:00.000Z'),
  track_id: null,
  track_title: null,
};

const trackRow: StudioMilestoneRow = {
  ...followerRow,
  kind: 'track_plays',
  threshold: 500,
  track_id: TRACK_ID,
  track_title: 'Night bus',
};

describe('followerMilestoneThresholdsUpTo', () => {
  it.each([
    [0, []],
    [9, []],
    [10, [10]],
    [27, [10, 25]],
    [1000, [10, 25, 50, 100, 250, 500, 1000]],
    [1999, [10, 25, 50, 100, 250, 500, 1000]],
    [3500, [10, 25, 50, 100, 250, 500, 1000, 2000, 3000]],
  ])(
    'reaches the thresholds at or below %i followers',
    (followerCount, expected) => {
      expect(followerMilestoneThresholdsUpTo(followerCount)).toEqual(expected);
    },
  );
});

describe('trackPlayMilestoneThresholdsUpTo', () => {
  it.each([
    [0, []],
    [99, []],
    [100, [100]],
    [999, [100, 500]],
    [10000, [100, 500, 1000, 5000, 10000]],
    [19999, [100, 500, 1000, 5000, 10000]],
    [35000, [100, 500, 1000, 5000, 10000, 20000, 30000]],
  ])('reaches the thresholds at or below %i plays', (playCount, expected) => {
    expect(trackPlayMilestoneThresholdsUpTo(playCount)).toEqual(expected);
  });
});

describe('artistPlayMilestoneThresholdsUpTo', () => {
  it.each([
    [999, []],
    [1000, [1000]],
    [99999, [1000, 10000]],
    [5000000, [1000, 10000, 100000]],
  ])('reaches the thresholds at or below %i plays', (playCount, expected) => {
    expect(artistPlayMilestoneThresholdsUpTo(playCount)).toEqual(expected);
  });
});

describe('toStudioMilestone', () => {
  it('maps a follower row with no track and an ISO reached date', () => {
    expect(toStudioMilestone(followerRow)).toEqual({
      id: MILESTONE_ID,
      kind: 'followers',
      threshold: 100,
      track: null,
      reachedAt: '2026-10-20T08:00:00.000Z',
    });
  });

  it('carries the track on a track plays row only', () => {
    expect(
      toStudioMilestone({ ...trackRow, kind: 'track_plays' }).track,
    ).toEqual({ id: TRACK_ID, title: 'Night bus' });
    expect(
      toStudioMilestone({ ...trackRow, kind: 'artist_plays' }).track,
    ).toBeNull();
  });

  it('puts no persona or member id on the wire', () => {
    expect(Object.keys(toStudioMilestone(followerRow)).sort()).toEqual([
      'id',
      'kind',
      'reachedAt',
      'threshold',
      'track',
    ]);
  });
});
