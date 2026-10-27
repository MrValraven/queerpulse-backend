import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  ARTIST_PLAY_DAYS_SQL,
  ARTIST_PLAY_TOTAL_SQL,
  StudioArtistPlaysService,
} from './studio-artist-plays.service';
import { StudioOwnershipService } from './studio-ownership.service';
import { studioPersonaTrackIdsSql } from './studio-play-attribution';

const VIEWER_ID = 'a7000000-0000-4000-8000-000000000001';
const PERSONA_ID = 'a8000000-0000-4000-8000-000000000001';

describe('StudioArtistPlaysService', () => {
  let query: jest.Mock;
  let ownership: { isPersonaMember: jest.Mock };
  let dayRows: { day: string; plays: string }[];
  let totalRows: { total: string }[];
  let service: StudioArtistPlaysService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-28T15:00:00.000Z'));
    dayRows = [];
    totalRows = [{ total: '0' }];
    query = jest.fn((sql: string) =>
      Promise.resolve(sql === ARTIST_PLAY_TOTAL_SQL ? totalRows : dayRows),
    );
    ownership = { isPersonaMember: jest.fn().mockResolvedValue(true) };
    service = new StudioArtistPlaysService(
      { query } as unknown as DataSource,
      ownership as unknown as StudioOwnershipService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('answers 404 Artist not found to a non-member before reading', async () => {
    ownership.isPersonaMember.mockResolvedValue(false);
    await expect(service.getArtistPlays(VIEWER_ID, PERSONA_ID)).rejects.toThrow(
      new NotFoundException('Artist not found'),
    );
    expect(ownership.isPersonaMember).toHaveBeenCalledWith(
      VIEWER_ID,
      PERSONA_ID,
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('reads the window days and the all-time total over own and credited tracks', async () => {
    await service.getArtistPlays(VIEWER_ID, PERSONA_ID);
    expect(query.mock.calls).toEqual([
      [ARTIST_PLAY_DAYS_SQL, [PERSONA_ID, '2026-10-01']],
      [ARTIST_PLAY_TOTAL_SQL, [PERSONA_ID]],
    ]);
    expect(ARTIST_PLAY_DAYS_SQL).toContain(studioPersonaTrackIdsSql('$1'));
    expect(ARTIST_PLAY_TOTAL_SQL).toContain(studioPersonaTrackIdsSql('$1'));
    expect(ARTIST_PLAY_DAYS_SQL).toContain('"daily"."day" >= $2::date');
    expect(ARTIST_PLAY_DAYS_SQL).toContain('ORDER BY "daily"."day" ASC');
  });

  it('answers 28 zero days for a persona with no plays', async () => {
    const plays = await service.getArtistPlays(VIEWER_ID, PERSONA_ID);
    expect(plays.days).toHaveLength(28);
    expect(
      plays.days.map((entry) => [entry.day, entry.plays]).slice(-1),
    ).toEqual([['2026-10-28', { value: 0, isBelowThreshold: false }]]);
    expect(
      plays.days.every(
        (entry) => entry.plays.value === 0 && !entry.plays.isBelowThreshold,
      ),
    ).toBe(true);
    expect([plays.total, plays.total28d]).toEqual([
      { value: 0, isBelowThreshold: false },
      { value: 0, isBelowThreshold: false },
    ]);
  });

  it('floors each day alone and the window once', async () => {
    dayRows = [
      { day: '2026-10-27', plays: '2' },
      { day: '2026-10-28', plays: '6' },
    ];
    totalRows = [{ total: '40' }];
    const plays = await service.getArtistPlays(VIEWER_ID, PERSONA_ID);
    expect(
      plays.days.slice(-2).map((entry) => [entry.day, entry.plays]),
    ).toEqual([
      ['2026-10-27', { value: null, isBelowThreshold: true }],
      ['2026-10-28', { value: 6, isBelowThreshold: false }],
    ]);
    expect([plays.total28d, plays.total]).toEqual([
      { value: 8, isBelowThreshold: false },
      { value: 40, isBelowThreshold: false },
    ]);
  });
});
