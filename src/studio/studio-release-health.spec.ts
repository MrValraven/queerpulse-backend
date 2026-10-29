import {
  StudioReleaseStatus,
  StudioReleaseType,
} from './entities/studio-release.entity';
import {
  StudioReleaseHealthItem,
  StudioReleaseHealthKey,
  StudioReleaseHealthRelease,
  StudioReleaseHealthTrack,
  toReleaseHealth,
} from './studio-release-health';

const completeRelease: StudioReleaseHealthRelease = {
  status: StudioReleaseStatus.Draft,
  type: StudioReleaseType.Album,
  coverKey: 'covers/a.jpg',
  description: 'A record about the sea',
  genres: ['house'],
  mood: 'warm',
  buyUrl: 'https://example.com/buy',
  tracksChangedAt: null,
  publishedAt: null,
};

const completeTrack: StudioReleaseHealthTrack = {
  credits: [{ role: 'producer', name: 'Ana' }] as never,
  lyrics: 'la la',
  syncedLyrics: null,
  withheldAt: null,
};

function isDoneOf(
  health: StudioReleaseHealthItem[],
  key: StudioReleaseHealthKey,
): boolean {
  return health.find((item) => item.key === key)?.isDone ?? false;
}

describe('toReleaseHealth', () => {
  it('lists the six keys in contract order for a music release with no track changes', () => {
    expect(
      toReleaseHealth(completeRelease, [completeTrack], null).map(
        (item) => item.key,
      ),
    ).toEqual([
      'cover',
      'description',
      'genreAndMood',
      'creditsOnEveryTrack',
      'lyrics',
      'buyLink',
    ]);
  });

  it('marks every item done for a complete release', () => {
    expect(
      toReleaseHealth(completeRelease, [completeTrack], null).every(
        (item) => item.isDone,
      ),
    ).toBe(true);
  });

  it('flags lyrics and buyLink as optional and nothing else', () => {
    expect(
      toReleaseHealth(completeRelease, [completeTrack], null)
        .filter((item) => item.isOptional)
        .map((item) => item.key),
    ).toEqual(['lyrics', 'buyLink']);
  });

  it('treats a whitespace description as missing', () => {
    const health = toReleaseHealth(
      { ...completeRelease, description: '   ' },
      [completeTrack],
      null,
    );
    expect(isDoneOf(health, 'description')).toBe(false);
  });

  it('needs at least one genre and a mood', () => {
    expect(
      isDoneOf(
        toReleaseHealth(
          { ...completeRelease, mood: null },
          [completeTrack],
          null,
        ),
        'genreAndMood',
      ),
    ).toBe(false);
    expect(
      isDoneOf(
        toReleaseHealth(completeRelease, [completeTrack], null),
        'genreAndMood',
      ),
    ).toBe(true);
    expect(
      isDoneOf(
        toReleaseHealth(
          { ...completeRelease, genres: [] },
          [completeTrack],
          null,
        ),
        'genreAndMood',
      ),
    ).toBe(false);
    expect(
      isDoneOf(
        toReleaseHealth(
          { ...completeRelease, genres: ['house', 'folk'] },
          [completeTrack],
          null,
        ),
        'genreAndMood',
      ),
    ).toBe(true);
  });

  it('marks the cover and buy link from their fields', () => {
    const health = toReleaseHealth(
      { ...completeRelease, coverKey: null, buyUrl: null },
      [completeTrack],
      null,
    );
    expect(isDoneOf(health, 'cover')).toBe(false);
    expect(isDoneOf(health, 'buyLink')).toBe(false);
  });

  it('ignores withheld tracks in the credit and lyrics checks', () => {
    const withheldBareTrack = {
      credits: [],
      lyrics: null,
      syncedLyrics: null,
      withheldAt: new Date(),
    };
    const health = toReleaseHealth(
      completeRelease,
      [completeTrack, withheldBareTrack],
      null,
    );
    expect(isDoneOf(health, 'creditsOnEveryTrack')).toBe(true);
    expect(isDoneOf(health, 'lyrics')).toBe(true);
  });

  it('needs a credit on every counted track', () => {
    const health = toReleaseHealth(
      completeRelease,
      [completeTrack, { ...completeTrack, credits: [] }],
      null,
    );
    expect(isDoneOf(health, 'creditsOnEveryTrack')).toBe(false);
  });

  it('accepts synced lyrics in place of plain lyrics and reads blank lyrics as missing', () => {
    const withSyncedLyrics = {
      ...completeTrack,
      lyrics: null,
      syncedLyrics: [{ ms: 0, text: 'a' }],
    };
    const withBlankLyrics = {
      ...completeTrack,
      lyrics: '  ',
      syncedLyrics: null,
    };
    expect(
      isDoneOf(
        toReleaseHealth(completeRelease, [withSyncedLyrics], null),
        'lyrics',
      ),
    ).toBe(true);
    expect(
      isDoneOf(
        toReleaseHealth(completeRelease, [withBlankLyrics], null),
        'lyrics',
      ),
    ).toBe(false);
  });

  it('marks the track checks undone when no track counts', () => {
    const health = toReleaseHealth(completeRelease, [], null);
    expect(isDoneOf(health, 'creditsOnEveryTrack')).toBe(false);
    expect(isDoneOf(health, 'lyrics')).toBe(false);
  });

  it('adds versionNote last and undone when the published release has unnoted changes', () => {
    const changedRelease = {
      ...completeRelease,
      status: StudioReleaseStatus.Published,
      publishedAt: new Date('2026-10-01T09:00:00.000Z'),
      tracksChangedAt: new Date('2026-10-10T09:00:00.000Z'),
    };
    expect(
      toReleaseHealth(changedRelease, [completeTrack], null).at(-1),
    ).toEqual({ key: 'versionNote', isDone: false, isOptional: false });
    expect(
      toReleaseHealth(
        changedRelease,
        [completeTrack],
        new Date('2026-10-11T09:00:00.000Z'),
      ).map((item) => item.key),
    ).not.toContain('versionNote');
  });

  it('gives a podcast release cover and description only', () => {
    expect(
      toReleaseHealth(
        { ...completeRelease, type: StudioReleaseType.Podcast },
        [],
        null,
      ).map((item) => item.key),
    ).toEqual(['cover', 'description']);
  });

  it('gives a taken-down release no health', () => {
    expect(
      toReleaseHealth(
        { ...completeRelease, status: StudioReleaseStatus.TakenDown },
        [completeTrack],
        null,
      ),
    ).toEqual([]);
  });
});
