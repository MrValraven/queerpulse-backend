import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { QuizshowRetentionService } from './quizshow-retention.service';
import type { QuizshowRuntimeService } from './quizshow-runtime.service';

describe('QuizshowRetentionService', () => {
  const NOW = 1_800_000_000_000;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const BATCH_SIZE = 2;
  let query: jest.Mock;
  let sweepIdleSessions: jest.Mock;
  let service: QuizshowRetentionService;

  const countRow = (deletedCount: number) => [{ deleted_count: deletedCount }];
  const statementsContaining = (fragment: string): [string, unknown[]][] =>
    (query.mock.calls as [string, unknown[]][]).filter(([statement]) =>
      statement.includes(fragment),
    );

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    query = jest.fn().mockResolvedValue(countRow(0));
    sweepIdleSessions = jest.fn().mockResolvedValue(0);
    const config = {
      get: jest.fn((key: string, fallback?: number) =>
        key === 'retention.batchSize'
          ? BATCH_SIZE
          : key === 'retention.maxBatchesPerRun'
            ? 5
            : fallback,
      ),
    };
    service = new QuizshowRetentionService(
      { query } as unknown as DataSource,
      config as unknown as ConfigService,
      { sweepIdleSessions } as unknown as QuizshowRuntimeService,
    );
    for (const method of ['log', 'error'] as const) {
      jest
        .spyOn(
          (service as unknown as { logger: Record<string, () => void> }).logger,
          method,
        )
        .mockImplementation(() => undefined);
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('deletes answers and votes of sessions that ended over 30 days ago, in batches', async () => {
    query.mockImplementation((statement: string) => {
      if (statement.includes('DELETE FROM "quizshow_votes"')) {
        return Promise.resolve(
          query.mock.calls.filter(([text]: [string]) =>
            text.includes('DELETE FROM "quizshow_votes"'),
          ).length === 1
            ? countRow(BATCH_SIZE)
            : countRow(1),
        );
      }
      return Promise.resolve(countRow(0));
    });

    await service.purgeExpiredPlays();

    const voteCalls = statementsContaining('DELETE FROM "quizshow_votes"');
    expect(voteCalls).toHaveLength(2);
    const [voteStatement, voteParameters] = voteCalls[0] as [string, unknown[]];
    expect(voteStatement).toContain('"session"."ended_at" < $1');
    expect(voteStatement).toContain('LIMIT $2');
    expect(voteParameters).toEqual([new Date(NOW - 30 * DAY_MS), BATCH_SIZE]);
    expect(statementsContaining('DELETE FROM "quizshow_answers"')).toHaveLength(
      1,
    );
    const order = (query.mock.calls as [string][]).map(([statement]) =>
      statement.includes('"quizshow_votes"')
        ? 'votes'
        : statement.includes('"quizshow_answers"')
          ? 'answers'
          : 'sessions',
    );
    expect(order.indexOf('votes')).toBeLessThan(order.indexOf('answers'));
    expect(order.indexOf('answers')).toBeLessThan(order.indexOf('sessions'));
  });

  it('deletes abandoned sessions whole after 30 days', async () => {
    await service.purgeExpiredPlays();
    const sessionCalls = statementsContaining(
      'DELETE FROM "quizshow_sessions"',
    );
    expect(sessionCalls).toHaveLength(1);
    const [statement, parameters] = sessionCalls[0] as [string, unknown[]];
    expect(statement).toContain(`"status" = 'abandoned'`);
    expect(statement).toContain('"ended_at" < $1');
    expect(parameters[0]).toEqual(new Date(NOW - 30 * DAY_MS));
  });

  it('keeps the players, teams and results of finished sessions', async () => {
    await service.purgeExpiredPlays();
    const statements = (query.mock.calls as [string][]).map(([text]) => text);
    const deletedTables = statements.flatMap((statement) =>
      [...statement.matchAll(/DELETE FROM "([a-z_]+)"/g)].map(
        (match) => match[1],
      ),
    );
    expect(new Set(deletedTables)).toEqual(
      new Set(['quizshow_votes', 'quizshow_answers', 'quizshow_sessions']),
    );
    const sessionStatement = statements.find((statement) =>
      statement.includes('DELETE FROM "quizshow_sessions"'),
    );
    expect(sessionStatement).not.toContain(`'finished'`);
    expect(sessionStatement).toContain(`"status" = 'abandoned'`);
  });

  it('sweeps lobby opens older than a day', async () => {
    query.mockImplementation((statement: string) => {
      if (statement.includes('DELETE FROM "quizshow_lobby_opens"')) {
        return Promise.resolve(
          statementsContaining('DELETE FROM "quizshow_lobby_opens"').length ===
            1
            ? countRow(BATCH_SIZE)
            : countRow(1),
        );
      }
      return Promise.resolve(countRow(0));
    });
    const logSpy = jest.spyOn(
      (service as unknown as { logger: { log: (message: string) => void } })
        .logger,
      'log',
    );

    await service.runDailySweep();

    const sweepCalls = statementsContaining(
      'DELETE FROM "quizshow_lobby_opens"',
    );
    expect(sweepCalls).toHaveLength(2);
    const [statement, parameters] = sweepCalls[0] as [string, unknown[]];
    expect(statement).toContain('"opened_at" < $1');
    expect(statement).toContain('LIMIT $2');
    expect(parameters).toEqual([new Date(NOW - DAY_MS), BATCH_SIZE]);
    expect(logSpy).toHaveBeenCalledWith(
      'Pulse Live retention removed 3 lobby open(s)',
    );
    const lastStatement = (query.mock.calls as [string][]).at(-1)?.[0];
    expect(lastStatement).toContain('DELETE FROM "quizshow_lobby_opens"');
  });

  it('logs and swallows a failure', async () => {
    query.mockRejectedValue(new Error('connection lost'));
    sweepIdleSessions.mockRejectedValue(new Error('runtime down'));
    await expect(service.purgeExpiredPlays()).resolves.toBeUndefined();
    await expect(service.sweepLobbyOpens()).resolves.toBeUndefined();
    await expect(service.abandonIdleSessions()).resolves.toBeUndefined();
    await expect(service.runDailySweep()).resolves.toBeUndefined();
  });

  it('abandons idle lobby, running and paused sessions in the daily sweep before purging', async () => {
    const callOrder: string[] = [];
    sweepIdleSessions.mockImplementation(() => {
      callOrder.push('sweep');
      return Promise.resolve(3);
    });
    query.mockImplementation(() => {
      callOrder.push('purge');
      return Promise.resolve(countRow(0));
    });

    await service.runDailySweep();

    expect(sweepIdleSessions).toHaveBeenCalledWith(NOW);
    expect(callOrder[0]).toBe('sweep');
    expect(callOrder.slice(1)).toContain('purge');
  });
});
