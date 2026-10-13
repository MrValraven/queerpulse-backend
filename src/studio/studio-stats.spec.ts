import {
  StudioRelease,
  StudioReleaseStatus,
} from './entities/studio-release.entity';
import { orderReleasesForStats, toStudioCount } from './studio-stats';

const release = (
  id: string,
  status: StudioReleaseStatus,
  publishedAt: string | null,
  updatedAt: string,
): StudioRelease =>
  ({
    id,
    status,
    publishedAt: publishedAt ? new Date(publishedAt) : null,
    updatedAt: new Date(updatedAt),
  }) as StudioRelease;

describe('toStudioCount', () => {
  it.each([
    [0, { value: 0, isBelowThreshold: false }],
    [1, { value: null, isBelowThreshold: true }],
    [4, { value: null, isBelowThreshold: true }],
    [5, { value: 5, isBelowThreshold: false }],
    [120, { value: 120, isBelowThreshold: false }],
  ])('reads %i as %p', (count, expected) => {
    expect(toStudioCount(count)).toEqual(expected);
  });
});

describe('orderReleasesForStats', () => {
  it('puts published releases first, newest first, then the rest by last edit', () => {
    const ordered = orderReleasesForStats([
      release(
        'draft-old',
        StudioReleaseStatus.Draft,
        null,
        '2026-10-01T00:00:00Z',
      ),
      release(
        'live-old',
        StudioReleaseStatus.Published,
        '2026-09-01T00:00:00Z',
        '2026-09-01T00:00:00Z',
      ),
      release(
        'down',
        StudioReleaseStatus.TakenDown,
        null,
        '2026-10-05T00:00:00Z',
      ),
      release(
        'live-new',
        StudioReleaseStatus.Published,
        '2026-10-02T00:00:00Z',
        '2026-10-02T00:00:00Z',
      ),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual([
      'live-new',
      'live-old',
      'down',
      'draft-old',
    ]);
  });
});
