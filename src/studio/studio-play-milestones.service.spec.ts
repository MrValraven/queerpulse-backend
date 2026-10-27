import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  ARTIST_PLAY_MILESTONES_INSERT_SQL,
  PLAY_MILESTONE_TOTALS_SQL,
  StudioPlayMilestonesService,
  TRACK_PLAY_MILESTONES_INSERT_SQL,
} from './studio-play-milestones.service';
import { STUDIO_ARTIST_PERSONA_KINDS } from './studio.constants';

const TRACK_ID = 'd4000000-0000-4000-8000-000000000001';
const RELEASE_PERSONA = 'd2000000-0000-4000-8000-000000000001';
const CREDITED_PERSONA = 'd2000000-0000-4000-8000-000000000002';

describe('StudioPlayMilestonesService', () => {
  let query: jest.Mock;
  let service: StudioPlayMilestonesService;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    query = jest.fn();
    service = new StudioPlayMilestonesService({
      query,
    } as unknown as DataSource);
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('writes track milestones for every attributed artist and artist milestones from each artist total', async () => {
    query
      .mockResolvedValueOnce([
        {
          artist_id: RELEASE_PERSONA,
          track_total: '1200',
          artist_total: '12000',
        },
        {
          artist_id: CREDITED_PERSONA,
          track_total: '1200',
          artist_total: '1500',
        },
      ])
      .mockResolvedValue([]);

    await service.recordPlayMilestones(TRACK_ID);

    expect(query.mock.calls).toEqual([
      [PLAY_MILESTONE_TOTALS_SQL, [TRACK_ID, [...STUDIO_ARTIST_PERSONA_KINDS]]],
      [
        TRACK_PLAY_MILESTONES_INSERT_SQL,
        [[RELEASE_PERSONA, CREDITED_PERSONA], [100, 500, 1000], TRACK_ID],
      ],
      [
        ARTIST_PLAY_MILESTONES_INSERT_SQL,
        [
          [RELEASE_PERSONA, RELEASE_PERSONA, CREDITED_PERSONA],
          [1000, 10000, 1000],
        ],
      ],
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('writes the track steps past the fixed list for a large total', async () => {
    query
      .mockResolvedValueOnce([
        {
          artist_id: RELEASE_PERSONA,
          track_total: '31000',
          artist_total: '31000',
        },
      ])
      .mockResolvedValue([]);

    await service.recordPlayMilestones(TRACK_ID);

    expect(query.mock.calls.slice(1)).toEqual([
      [
        TRACK_PLAY_MILESTONES_INSERT_SQL,
        [
          [RELEASE_PERSONA],
          [100, 500, 1000, 5000, 10000, 20000, 30000],
          TRACK_ID,
        ],
      ],
      [
        ARTIST_PLAY_MILESTONES_INSERT_SQL,
        [
          [RELEASE_PERSONA, RELEASE_PERSONA],
          [1000, 10000],
        ],
      ],
    ]);
  });

  it('writes nothing when no attributed persona is an artist kind or no threshold is reached', async () => {
    query.mockResolvedValueOnce([]);

    await service.recordPlayMilestones(TRACK_ID);

    expect(query).toHaveBeenCalledTimes(1);

    query.mockReset();
    query.mockResolvedValueOnce([
      { artist_id: RELEASE_PERSONA, track_total: '99', artist_total: '999' },
      { artist_id: CREDITED_PERSONA, track_total: '99', artist_total: '0' },
    ]);

    await service.recordPlayMilestones(TRACK_ID);

    expect(query.mock.calls).toEqual([
      [PLAY_MILESTONE_TOTALS_SQL, [TRACK_ID, [...STUDIO_ARTIST_PERSONA_KINDS]]],
    ]);
  });

  it('writes artist milestones alone when the track total is below the first threshold', async () => {
    query
      .mockResolvedValueOnce([
        {
          artist_id: CREDITED_PERSONA,
          track_total: '40',
          artist_total: '1000',
        },
      ])
      .mockResolvedValue([]);

    await service.recordPlayMilestones(TRACK_ID);

    expect(query.mock.calls.slice(1)).toEqual([
      [ARTIST_PLAY_MILESTONES_INSERT_SQL, [[CREDITED_PERSONA], [1000]]],
    ]);
  });

  it('lets repeats pass through ON CONFLICT DO NOTHING', () => {
    for (const sql of [
      TRACK_PLAY_MILESTONES_INSERT_SQL,
      ARTIST_PLAY_MILESTONES_INSERT_SQL,
    ]) {
      expect(sql).toMatch(/ON CONFLICT DO NOTHING/);
    }
    expect(TRACK_PLAY_MILESTONES_INSERT_SQL).toContain(
      `SELECT "artist_id", 'track_plays', "threshold", $3::uuid`,
    );
    expect(ARTIST_PLAY_MILESTONES_INSERT_SQL).toContain(
      `unnest($1::uuid[], $2::int[]) AS "reached"("artist_id", "threshold")`,
    );
  });

  it('reads the artist kind as text and orders the artists by id', () => {
    expect(PLAY_MILESTONE_TOTALS_SQL).toContain(
      `"artist"."kind"::text = ANY($2::text[])`,
    );
    expect(PLAY_MILESTONE_TOTALS_SQL).toContain(
      `"attributed_credit"."status" = 'accepted'`,
    );
    expect(PLAY_MILESTONE_TOTALS_SQL).toMatch(/ORDER BY "artist"\."id" ASC$/);
  });

  it('logs a failed write without a track or persona id and throws nothing', async () => {
    query
      .mockResolvedValueOnce([
        {
          artist_id: RELEASE_PERSONA,
          track_total: '500',
          artist_total: '500',
        },
      ])
      .mockRejectedValueOnce(
        Object.assign(
          new Error(
            `Key (subprofile_id, track_id)=(${RELEASE_PERSONA}, ${TRACK_ID}) is not present`,
          ),
          { code: '23503' },
        ),
      );

    await expect(
      service.recordPlayMilestones(TRACK_ID),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = warnSpy.mock.calls.flat().join(' ');
    expect(logged).toContain(
      'Recording play milestones failed: Error (code 23503)',
    );
    expect(logged).not.toContain(TRACK_ID);
    expect(logged).not.toContain(RELEASE_PERSONA);
  });
});
