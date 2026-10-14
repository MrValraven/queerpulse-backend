import { StudioReleaseType } from './entities/studio-release.entity';
import {
  firstUnmetPublishRequirement,
  toIsoDate,
  unmetPublishRequirements,
} from './studio-publish-rule';

const readyRelease = {
  type: StudioReleaseType.Album,
  title: 'Lisbon at four',
  coverKey:
    'persona/11111111-2222-4333-8444-555555555555/66666666-7777-4888-9999-000000000000.jpg',
  rightsConfirmedAt: new Date('2026-10-08T09:00:00.000Z'),
};
const readyTrack = {
  audioKey: 'studio-audio/a/b.mp3',
  durationSeconds: 240,
  sources: [],
};
const SOURCE = { title: 'Rumour Has It', artist: 'Adele' };

describe('the publish rule', () => {
  it('passes a titled release with a cover, the rights confirmed and a playable track', () => {
    expect(firstUnmetPublishRequirement(readyRelease, [readyTrack])).toBeNull();
  });

  it.each([
    [
      'a blank title',
      { ...readyRelease, title: '   ' },
      [readyTrack],
      'studio_publish_missing_title',
    ],
    [
      'no cover',
      { ...readyRelease, coverKey: null },
      [readyTrack],
      'studio_publish_missing_cover',
    ],
    [
      'no rights confirmation',
      { ...readyRelease, rightsConfirmedAt: null },
      [readyTrack],
      'studio_publish_missing_rights',
    ],
    ['no tracks', readyRelease, [], 'studio_publish_missing_tracks'],
    [
      'a track with no audio',
      readyRelease,
      [readyTrack, { audioKey: null, durationSeconds: null, sources: [] }],
      'studio_publish_tracks_pending',
    ],
    [
      'a track whose duration is unread',
      readyRelease,
      [
        {
          audioKey: 'studio-audio/a/c.mp3',
          durationSeconds: null,
          sources: [],
        },
      ],
      'studio_publish_tracks_pending',
    ],
  ] as const)('refuses %s', (_label, release, tracks, expectedCode) => {
    expect(firstUnmetPublishRequirement(release, [...tracks])).toBe(
      expectedCode,
    );
  });

  it('lists every unmet piece in the order the checklist shows them', () => {
    expect(
      unmetPublishRequirements(
        {
          type: StudioReleaseType.Album,
          title: '',
          coverKey: null,
          rightsConfirmedAt: null,
        },
        [],
      ),
    ).toEqual([
      'studio_publish_missing_title',
      'studio_publish_missing_cover',
      'studio_publish_missing_rights',
      'studio_publish_missing_tracks',
    ]);
  });

  it('writes a UTC calendar date', () => {
    expect(toIsoDate(new Date('2026-10-08T23:30:00.000Z'))).toBe('2026-10-08');
  });

  // Studio artist kinds.
  it.each([
    StudioReleaseType.Mix,
    StudioReleaseType.Edit,
    StudioReleaseType.LipSync,
  ])(
    'asks a %s release for a source on every track, after the audio',
    (type) => {
      const sourcedTrack = { ...readyTrack, sources: [SOURCE] };
      expect(
        firstUnmetPublishRequirement({ ...readyRelease, type }, [
          sourcedTrack,
          readyTrack,
        ]),
      ).toBe('studio_publish_missing_sources');
      expect(
        firstUnmetPublishRequirement({ ...readyRelease, type }, [sourcedTrack]),
      ).toBeNull();
      expect(
        unmetPublishRequirements({ ...readyRelease, type }, [
          { audioKey: null, durationSeconds: null, sources: [] },
        ]),
      ).toEqual([
        'studio_publish_tracks_pending',
        'studio_publish_missing_sources',
      ]);
    },
  );

  it.each([
    StudioReleaseType.Album,
    StudioReleaseType.Podcast,
    StudioReleaseType.Ep,
  ])('asks nothing about sources of a %s release', (type) => {
    expect(
      firstUnmetPublishRequirement({ ...readyRelease, type }, [readyTrack]),
    ).toBeNull();
  });
});
