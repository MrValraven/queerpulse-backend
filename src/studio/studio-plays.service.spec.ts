import { Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { StudioPlayGate, StudioPlayGateDecision } from './studio-play-gate';
import { StudioPlayMilestonesService } from './studio-play-milestones.service';
import {
  DAILY_PLAY_UPSERT_SQL,
  LISTEN_INSERT_SQL,
  PLAY_ELIGIBILITY_SQL,
  StudioPlaysService,
} from './studio-plays.service';

const USER_ID = 'd1000000-0000-4000-8000-000000000001';
const TRACK_ID = 'd4000000-0000-4000-8000-000000000001';

describe('StudioPlaysService', () => {
  let manager: { query: jest.Mock };
  let dataSource: { query: jest.Mock; transaction: jest.Mock };
  let gate: { admit: jest.Mock<StudioPlayGateDecision, [string]> };
  let playMilestones: { recordPlayMilestones: jest.Mock };
  let service: StudioPlaysService;
  let warnSpy: jest.SpyInstance;

  const buildService = (playGate: StudioPlayGate): StudioPlaysService =>
    new StudioPlaysService(
      dataSource as unknown as DataSource,
      playGate,
      playMilestones as unknown as StudioPlayMilestonesService,
    );

  beforeEach(() => {
    manager = { query: jest.fn().mockResolvedValue([]) };
    dataSource = {
      query: jest.fn().mockResolvedValue([{ is_history_on: true }]),
      transaction: jest.fn(
        async (work: (inner: EntityManager) => Promise<unknown>) =>
          work(manager as unknown as EntityManager),
      ),
    };
    gate = {
      admit: jest
        .fn<StudioPlayGateDecision, [string]>()
        .mockReturnValue('admitted'),
    };
    playMilestones = {
      recordPlayMilestones: jest.fn().mockResolvedValue(undefined),
    };
    service = buildService(gate as unknown as StudioPlayGate);
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    jest.useRealTimers();
  });

  it('reads nothing when the gate refuses', async () => {
    for (const decision of ['throttled', 'too_soon'] as const) {
      gate.admit.mockReturnValue(decision);

      await expect(
        service.recordPlay(USER_ID, TRACK_ID),
      ).resolves.toBeUndefined();
    }

    expect(dataSource.query).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(playMilestones.recordPlayMilestones).not.toHaveBeenCalled();
  });

  it('passes the track and the caller to the eligibility read', async () => {
    await service.recordPlay(USER_ID, TRACK_ID);

    expect(gate.admit.mock.calls).toEqual([[USER_ID]]);
    expect(dataSource.query.mock.calls).toEqual([
      [PLAY_ELIGIBILITY_SQL, [TRACK_ID, USER_ID]],
    ]);
  });

  it('keeps the slot when the eligibility read finds no row', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-27T12:00:00.000Z'));
    const realGate = new StudioPlayGate();
    const admitSpy = jest.spyOn(realGate, 'admit');
    const gatedService = buildService(realGate);
    dataSource.query.mockResolvedValue([]);

    await expect(
      gatedService.recordPlay(USER_ID, TRACK_ID),
    ).resolves.toBeUndefined();
    jest.setSystemTime(new Date('2026-10-27T12:00:10.000Z'));
    await expect(
      gatedService.recordPlay(USER_ID, TRACK_ID),
    ).resolves.toBeUndefined();

    expect(admitSpy.mock.calls).toEqual([[USER_ID], [USER_ID]]);
    expect(
      admitSpy.mock.results.map((result): unknown => result.value),
    ).toEqual(['admitted', 'too_soon']);
    expect(dataSource.query).toHaveBeenCalledTimes(1);
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(playMilestones.recordPlayMilestones).not.toHaveBeenCalled();
  });

  it('counts the daily total and writes a listen while history is on', async () => {
    await service.recordPlay(USER_ID, TRACK_ID);

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(manager.query.mock.calls).toEqual([
      [DAILY_PLAY_UPSERT_SQL, [TRACK_ID]],
      [LISTEN_INSERT_SQL, [USER_ID, TRACK_ID]],
    ]);
  });

  it('counts the daily total and writes no listen while history is paused', async () => {
    dataSource.query.mockResolvedValue([{ is_history_on: false }]);

    await service.recordPlay(USER_ID, TRACK_ID);

    expect(manager.query.mock.calls).toEqual([
      [DAILY_PLAY_UPSERT_SQL, [TRACK_ID]],
    ]);
    expect(playMilestones.recordPlayMilestones.mock.calls).toEqual([
      [TRACK_ID],
    ]);
  });

  it('writes milestones after the transaction commits', async () => {
    const order: string[] = [];
    dataSource.transaction.mockImplementation(
      async (work: (inner: EntityManager) => Promise<unknown>) => {
        const result = await work(manager as unknown as EntityManager);
        order.push('committed');
        return result;
      },
    );
    playMilestones.recordPlayMilestones.mockImplementation(() => {
      order.push('milestones');
      return Promise.resolve();
    });

    await service.recordPlay(USER_ID, TRACK_ID);

    expect(order).toEqual(['committed', 'milestones']);
    expect(playMilestones.recordPlayMilestones.mock.calls).toEqual([
      [TRACK_ID],
    ]);
  });

  it('writes no milestones when the transaction fails', async () => {
    dataSource.transaction.mockRejectedValue(new Error('deadlock detected'));

    await expect(
      service.recordPlay(USER_ID, TRACK_ID),
    ).resolves.toBeUndefined();

    expect(playMilestones.recordPlayMilestones).not.toHaveBeenCalled();
  });

  it('swallows a failed write and logs no track or member id', async () => {
    dataSource.transaction.mockRejectedValue(
      Object.assign(
        new Error(
          `Key (track_id)=(${TRACK_ID}) is not present; user ${USER_ID}`,
        ),
        { code: '23503' },
      ),
    );

    await expect(
      service.recordPlay(USER_ID, TRACK_ID),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = warnSpy.mock.calls.flat().join(' ');
    expect(logged).toContain('Recording a play failed: Error (code 23503)');
    expect(logged).not.toContain(TRACK_ID);
    expect(logged).not.toContain(USER_ID);
  });

  it('swallows a failed eligibility read and logs no track or member id', async () => {
    dataSource.query.mockRejectedValue(
      new Error(`invalid input syntax for type uuid: "${TRACK_ID}"`),
    );

    await expect(
      service.recordPlay(USER_ID, TRACK_ID),
    ).resolves.toBeUndefined();

    const logged = warnSpy.mock.calls.flat().join(' ');
    expect(logged).toContain('Recording a play failed: Error');
    expect(logged).not.toContain(TRACK_ID);
    expect(logged).not.toContain(USER_ID);
  });

  it('puts no body text into the SQL', () => {
    expect(PLAY_ELIGIBILITY_SQL).toContain(`"release"."type" <> 'podcast'`);
    expect(PLAY_ELIGIBILITY_SQL).toContain(
      `COALESCE("preferences"."is_listening_history_on", true) AS "is_history_on"`,
    );
    expect(PLAY_ELIGIBILITY_SQL).toContain(
      `"self_credit"."status" = 'accepted'`,
    );
    expect(DAILY_PLAY_UPSERT_SQL).toContain(
      `VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 1)`,
    );
    expect(DAILY_PLAY_UPSERT_SQL).toMatch(
      /ON CONFLICT \("track_id", "day"\) DO UPDATE SET "plays" = "studio_track_play_daily"\."plays" \+ 1/,
    );
    expect(LISTEN_INSERT_SQL).toContain(
      `("user_id", "track_id") VALUES ($1, $2)`,
    );
    for (const sql of [
      PLAY_ELIGIBILITY_SQL,
      DAILY_PLAY_UPSERT_SQL,
      LISTEN_INSERT_SQL,
    ]) {
      expect(sql).not.toMatch(/\$[3-9]/);
    }
  });
});
