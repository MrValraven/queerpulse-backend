import { LessThan, Repository } from 'typeorm';
import { StudioTrack } from './entities/studio-track.entity';
import {
  StudioGaplessCandidate,
  findGaplessAfterTrackId,
  previousPlayableTrackId,
} from './studio-gapless';

const RELEASE_ID = 'd7000000-0000-4000-8000-000000000001';

const candidate = (
  id: string,
  position: number,
  overrides: Partial<StudioGaplessCandidate> = {},
): StudioGaplessCandidate => ({
  id,
  position,
  audioKey: `studio-audio/${id}.mp3`,
  durationSeconds: 200,
  withheldAt: null,
  ...overrides,
});

describe('previousPlayableTrackId', () => {
  it('picks the nearest earlier playable track', () => {
    expect(
      previousPlayableTrackId([candidate('third', 3), candidate('second', 2)]),
    ).toBe('third');
  });

  it('skips tracks without audio and withheld tracks', () => {
    expect(
      previousPlayableTrackId([
        candidate('uploading', 4, { audioKey: null, durationSeconds: null }),
        candidate('unmeasured', 3, { durationSeconds: null }),
        candidate('withheld', 2, {
          withheldAt: new Date('2026-10-14T10:00:00.000Z'),
        }),
        candidate('first', 1),
      ]),
    ).toBe('first');
  });

  it('answers null when no earlier track plays', () => {
    expect(previousPlayableTrackId([])).toBeNull();
    expect(
      previousPlayableTrackId([
        candidate('uploading', 1, { audioKey: null, durationSeconds: null }),
      ]),
    ).toBeNull();
  });
});

describe('findGaplessAfterTrackId', () => {
  let tracks: { find: jest.Mock };

  beforeEach(() => {
    tracks = { find: jest.fn().mockResolvedValue([]) };
  });

  const lookup = (isGapless: boolean, position: number) =>
    findGaplessAfterTrackId(
      tracks as unknown as Repository<StudioTrack>,
      { id: RELEASE_ID, isGapless },
      { position },
    );

  it('answers null without a query on a release that is not gapless', async () => {
    expect(await lookup(false, 3)).toBeNull();
    expect(tracks.find).not.toHaveBeenCalled();
  });

  it('reads the earlier tracks nearest first and picks the playable one', async () => {
    tracks.find.mockResolvedValue([
      candidate('withheld', 2, {
        withheldAt: new Date('2026-10-14T10:00:00.000Z'),
      }),
      candidate('first', 1),
    ]);
    expect(await lookup(true, 3)).toBe('first');
    expect(tracks.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { releaseId: RELEASE_ID, position: LessThan(3) },
        order: { position: 'DESC' },
      }),
    );
  });

  it('answers null for the first track of a gapless release', async () => {
    expect(await lookup(true, 1)).toBeNull();
  });
});
