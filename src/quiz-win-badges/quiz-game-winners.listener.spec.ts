import type { DataSource, EntityManager } from 'typeorm';
import type { QuizEventGameFinishedEvent } from '../quizshow/quizshow-game-finished.events';
import {
  ELIGIBLE_WINNER_USER_IDS_SQL,
  GAME_SLOT_DEFINITIONS_SQL,
  type QuizBadgeAwardingService,
  type QuizBadgeNewWin,
} from './quiz-badge-awarding.service';
import {
  EVENT_PUBLIC_AT_AWARD_SQL,
  INSERT_GAME_WINNER_SQL,
  LIVE_SESSION_WINNERS_SQL,
  QUIZ_WIN_RECORD_RETRY_DELAYS_MS,
  QuizGameWinnersListener,
} from './quiz-game-winners.listener';
import { QUIZ_EVENT_BADGES_LOCK_SQL } from './quiz-win-badges.constants';

const FINISHED_AT = new Date('2026-11-24T20:00:00.000Z');

/** A driver error as TypeORM raises it, with a Postgres code and a text that
 *  must stay out of the logs. */
function databaseError(code: string): Error {
  return Object.assign(new Error('connection to 10.0.0.5 refused for ana'), {
    code,
  });
}

function candidate(
  userId: string,
  screenName = 'Ana',
  teamName: string | null = null,
) {
  return { userId, screenName, teamName };
}

function finishedEvent(
  overrides: Partial<QuizEventGameFinishedEvent> = {},
): QuizEventGameFinishedEvent {
  return {
    sessionId: 'session-1',
    eventId: 'event-1',
    gameNumber: 2,
    finishedAt: FINISHED_AT,
    eventTitle: 'Quiz night',
    isAdultsOnly: false,
    winners: [candidate('user-1')],
    ...overrides,
  };
}

function slotRow(id: string) {
  return {
    id,
    badge_key: `quiz:${id}`,
    name_en: `Badge ${id}`,
    name_pt: null,
  };
}

function newWin(userId: string, winId: string): QuizBadgeNewWin {
  return {
    winId,
    userId,
    badgeKey: 'quiz:badge-1',
    badgeNameEn: 'Badge badge-1',
    badgeNamePt: null,
    eventName: 'Quiz night',
  };
}

describe('QuizGameWinnersListener', () => {
  let manager: { query: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let awarding: { awardWin: jest.Mock; notifyNewWins: jest.Mock };
  let listener: QuizGameWinnersListener;
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  /** Answers each statement from the map and every other one with no rows. */
  function byStatement(answers: Record<string, unknown[]>) {
    return (statement: string): Promise<unknown[]> =>
      Promise.resolve(answers[statement] ?? []);
  }

  beforeEach(() => {
    manager = { query: jest.fn() };
    manager.query.mockImplementation(
      byStatement({
        [ELIGIBLE_WINNER_USER_IDS_SQL]: [{ id: 'user-1' }],
        [LIVE_SESSION_WINNERS_SQL]: [{ user_id: 'user-1' }],
      }),
    );
    dataSource = {
      transaction: jest.fn(
        (callback: (entityManager: EntityManager) => Promise<unknown>) =>
          callback(manager as unknown as EntityManager),
      ),
    };
    awarding = {
      awardWin: jest.fn().mockResolvedValue(null),
      notifyNewWins: jest.fn().mockResolvedValue(undefined),
    };
    listener = new QuizGameWinnersListener(
      dataSource as unknown as DataSource,
      awarding as unknown as QuizBadgeAwardingService,
    );
    errorSpy = jest
      .spyOn(
        (listener as unknown as { logger: { error: () => void } }).logger,
        'error',
      )
      .mockImplementation(() => undefined);
    warnSpy = jest
      .spyOn(
        (listener as unknown as { logger: { warn: () => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('takes the event lock before writing winners', async () => {
    await listener.onEventGameFinished(finishedEvent());
    expect(manager.query.mock.calls[0]).toEqual([
      QUIZ_EVENT_BADGES_LOCK_SQL,
      ['event-1'],
    ]);
  });

  it('records every eligible candidate and drops a suspended or deleted one', async () => {
    await listener.onEventGameFinished(
      finishedEvent({ winners: [candidate('user-1'), candidate('user-2')] }),
    );
    expect(manager.query).toHaveBeenCalledWith(ELIGIBLE_WINNER_USER_IDS_SQL, [
      ['user-1', 'user-2'],
    ]);
    expect(manager.query).toHaveBeenCalledWith(INSERT_GAME_WINNER_SQL, [
      'event-1',
      'session-1',
      2,
      FINISHED_AT,
      'user-1',
      'Ana',
      null,
    ]);
    expect(manager.query).not.toHaveBeenCalledWith(
      INSERT_GAME_WINNER_SQL,
      expect.arrayContaining(['user-2']),
    );
  });

  it('records the team name of a team winner', async () => {
    await listener.onEventGameFinished(
      finishedEvent({ winners: [candidate('user-1', 'Ana', 'Rainbow Owls')] }),
    );
    expect(manager.query).toHaveBeenCalledWith(INSERT_GAME_WINNER_SQL, [
      'event-1',
      'session-1',
      2,
      FINISHED_AT,
      'user-1',
      'Ana',
      'Rainbow Owls',
    ]);
  });

  it('records winners for a game with no badges attached', async () => {
    await listener.onEventGameFinished(finishedEvent());
    expect(manager.query).toHaveBeenCalledWith(GAME_SLOT_DEFINITIONS_SQL, [
      'event-1',
      2,
    ]);
    expect(manager.query).toHaveBeenCalledWith(
      INSERT_GAME_WINNER_SQL,
      expect.arrayContaining(['user-1']),
    );
    expect(awarding.awardWin).not.toHaveBeenCalled();
  });

  it('awards each slot badge to each live winner with the event snapshot', async () => {
    manager.query.mockImplementation(
      byStatement({
        [ELIGIBLE_WINNER_USER_IDS_SQL]: [{ id: 'user-1' }],
        [GAME_SLOT_DEFINITIONS_SQL]: [slotRow('badge-1'), slotRow('badge-2')],
        [EVENT_PUBLIC_AT_AWARD_SQL]: [{ is_public: true }],
        [LIVE_SESSION_WINNERS_SQL]: [{ user_id: 'user-1' }],
      }),
    );
    await listener.onEventGameFinished(finishedEvent({ isAdultsOnly: true }));

    expect(awarding.awardWin).toHaveBeenCalledTimes(2);
    for (const badgeId of ['badge-1', 'badge-2']) {
      expect(awarding.awardWin).toHaveBeenCalledWith(manager, {
        definition: {
          id: badgeId,
          badgeKey: `quiz:${badgeId}`,
          nameEn: `Badge ${badgeId}`,
          namePt: null,
        },
        userId: 'user-1',
        eventId: 'event-1',
        sessionId: 'session-1',
        gameNumber: 2,
        eventName: 'Quiz night',
        eventWasPublic: true,
        eventWasAdultsOnly: true,
        wonAt: FINISHED_AT,
      });
    }
  });

  it('snapshots the event as public only when it is public and published', () => {
    expect(EVENT_PUBLIC_AT_AWARD_SQL).toContain(
      `("visibility" = 'public' AND "status" = 'published') AS "is_public"`,
    );
  });

  it('marks the win as not public when the event read finds no row', async () => {
    manager.query.mockImplementation(
      byStatement({
        [GAME_SLOT_DEFINITIONS_SQL]: [slotRow('badge-1')],
        [LIVE_SESSION_WINNERS_SQL]: [{ user_id: 'user-1' }],
      }),
    );
    await listener.onEventGameFinished(finishedEvent());
    expect(manager.query).toHaveBeenCalledWith(EVENT_PUBLIC_AT_AWARD_SQL, [
      'event-1',
    ]);
    expect(awarding.awardWin).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({ eventWasPublic: false }),
    );
  });

  it('awards in badge key order and then member id order', async () => {
    manager.query.mockImplementation(
      byStatement({
        [ELIGIBLE_WINNER_USER_IDS_SQL]: [{ id: 'user-1' }, { id: 'user-2' }],
        [GAME_SLOT_DEFINITIONS_SQL]: [slotRow('badge-2'), slotRow('badge-1')],
        [EVENT_PUBLIC_AT_AWARD_SQL]: [{ is_public: true }],
        [LIVE_SESSION_WINNERS_SQL]: [
          { user_id: 'user-2' },
          { user_id: 'user-1' },
        ],
      }),
    );
    await listener.onEventGameFinished(
      finishedEvent({ winners: [candidate('user-1'), candidate('user-2')] }),
    );
    const awardCalls = awarding.awardWin.mock.calls as [
      unknown,
      { definition: { id: string }; userId: string },
    ][];
    expect(
      awardCalls.map(([, input]) => `${input.definition.id}/${input.userId}`),
    ).toEqual([
      'badge-1/user-1',
      'badge-1/user-2',
      'badge-2/user-1',
      'badge-2/user-2',
    ]);
  });

  it('marks the win as not public for a members event', async () => {
    manager.query.mockImplementation(
      byStatement({
        [GAME_SLOT_DEFINITIONS_SQL]: [slotRow('badge-1')],
        [EVENT_PUBLIC_AT_AWARD_SQL]: [{ is_public: false }],
        [LIVE_SESSION_WINNERS_SQL]: [{ user_id: 'user-1' }],
      }),
    );
    await listener.onEventGameFinished(finishedEvent());
    expect(awarding.awardWin).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({ eventWasPublic: false }),
    );
  });

  it('awards only the winners the live read returns, so a revoked winner gets nothing', async () => {
    manager.query.mockImplementation(
      byStatement({
        [ELIGIBLE_WINNER_USER_IDS_SQL]: [{ id: 'user-1' }, { id: 'user-2' }],
        [GAME_SLOT_DEFINITIONS_SQL]: [slotRow('badge-1')],
        [EVENT_PUBLIC_AT_AWARD_SQL]: [{ is_public: true }],
        [LIVE_SESSION_WINNERS_SQL]: [{ user_id: 'user-2' }],
      }),
    );
    await listener.onEventGameFinished(
      finishedEvent({ winners: [candidate('user-1'), candidate('user-2')] }),
    );
    expect(manager.query).toHaveBeenCalledWith(LIVE_SESSION_WINNERS_SQL, [
      'session-1',
    ]);
    expect(awarding.awardWin).toHaveBeenCalledTimes(1);
    expect(awarding.awardWin).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({ userId: 'user-2' }),
    );
  });

  it('notifies only after the transaction resolved, with the non-null wins', async () => {
    const callOrder: string[] = [];
    manager.query.mockImplementation(
      byStatement({
        [ELIGIBLE_WINNER_USER_IDS_SQL]: [{ id: 'user-1' }, { id: 'user-2' }],
        [GAME_SLOT_DEFINITIONS_SQL]: [slotRow('badge-1')],
        [EVENT_PUBLIC_AT_AWARD_SQL]: [{ is_public: true }],
        [LIVE_SESSION_WINNERS_SQL]: [
          { user_id: 'user-1' },
          { user_id: 'user-2' },
        ],
      }),
    );
    const firstWin = newWin('user-1', 'win-1');
    awarding.awardWin
      .mockResolvedValueOnce(firstWin)
      .mockResolvedValueOnce(null);
    dataSource.transaction.mockImplementation(
      async (callback: (entityManager: EntityManager) => Promise<unknown>) => {
        const result = await callback(manager as unknown as EntityManager);
        callOrder.push('transaction resolved');
        return result;
      },
    );
    awarding.notifyNewWins.mockImplementation(() => {
      callOrder.push('notified');
      return Promise.resolve();
    });

    await listener.onEventGameFinished(
      finishedEvent({ winners: [candidate('user-1'), candidate('user-2')] }),
    );

    expect(callOrder).toEqual(['transaction resolved', 'notified']);
    expect(awarding.notifyNewWins).toHaveBeenCalledTimes(1);
    expect(awarding.notifyNewWins).toHaveBeenCalledWith([firstWin]);
  });

  it('waits 500 ms, 2 s and 10 s between the retries', () => {
    expect(QUIZ_WIN_RECORD_RETRY_DELAYS_MS).toEqual([500, 2_000, 10_000]);
  });

  it('retries three times after each wait and then logs the session id and code only', async () => {
    jest.useFakeTimers();
    dataSource.transaction.mockRejectedValue(databaseError('08006'));

    const finished = listener.onEventGameFinished(finishedEvent());
    await jest.advanceTimersByTimeAsync(499);
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await jest.advanceTimersByTimeAsync(1_999);
    expect(dataSource.transaction).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    await jest.advanceTimersByTimeAsync(9_999);
    expect(dataSource.transaction).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(1);
    await expect(finished).resolves.toBeUndefined();

    expect(dataSource.transaction).toHaveBeenCalledTimes(4);
    expect(warnSpy.mock.calls).toEqual([
      ['Quiz win record attempt 1 of 4 failed for session session-1 (08006)'],
      ['Quiz win record attempt 2 of 4 failed for session session-1 (08006)'],
      ['Quiz win record attempt 3 of 4 failed for session session-1 (08006)'],
      ['Quiz win record attempt 4 of 4 failed for session session-1 (08006)'],
    ]);
    expect(errorSpy.mock.calls).toEqual([
      ['Quiz win record failed for session session-1 (08006)'],
    ]);
    const loggedCalls = [
      ...(warnSpy.mock.calls as unknown[][]),
      ...(errorSpy.mock.calls as unknown[][]),
    ];
    const loggedLines = loggedCalls.map((call) => String(call[0]));
    for (const loggedLine of loggedLines) {
      expect(loggedLine).not.toContain('refused');
      expect(loggedLine).not.toContain('user-1');
    }
    expect(awarding.notifyNewWins).not.toHaveBeenCalled();
  });

  it('logs the code of the last failure on the final line', async () => {
    jest.useFakeTimers();
    dataSource.transaction
      .mockRejectedValueOnce(databaseError('40P01'))
      .mockRejectedValueOnce(databaseError('40P01'))
      .mockRejectedValueOnce(databaseError('40P01'))
      .mockRejectedValueOnce(databaseError('57P01'));

    const finished = listener.onEventGameFinished(finishedEvent());
    await jest.advanceTimersByTimeAsync(12_500);
    await expect(finished).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      'Quiz win record failed for session session-1 (57P01)',
    );
  });

  it('stops retrying after a success and logs only the failed attempt', async () => {
    jest.useFakeTimers();
    dataSource.transaction
      .mockRejectedValueOnce(databaseError('40P01'))
      .mockImplementation(
        (callback: (entityManager: EntityManager) => Promise<unknown>) =>
          callback(manager as unknown as EntityManager),
      );

    const finished = listener.onEventGameFinished(finishedEvent());
    await jest.advanceTimersByTimeAsync(499);
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(finished).resolves.toBeUndefined();

    expect(dataSource.transaction).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls).toEqual([
      ['Quiz win record attempt 1 of 4 failed for session session-1 (40P01)'],
    ]);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(awarding.notifyNewWins).toHaveBeenCalledTimes(1);
  });
});
