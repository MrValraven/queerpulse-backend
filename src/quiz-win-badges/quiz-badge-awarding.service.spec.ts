import { EntityManager } from 'typeorm';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import {
  DELETE_AWARD_WITHOUT_WINS_SQL,
  DELETE_GAME_WINS_SQL,
  DELETE_REVOKED_BADGE_NOTIFICATIONS_SQL,
  ELIGIBLE_WINNER_USER_IDS_SQL,
  GAME_SLOT_DEFINITIONS_SQL,
  INSERT_QUIZ_BADGE_AWARD_SQL,
  INSERT_QUIZ_BADGE_WIN_SQL,
  MARK_WINNER_REVOKED_SQL,
  QuizBadgeAwardInput,
  QuizBadgeAwardingService,
  QuizBadgeNewWin,
  SYNC_QUIZ_BADGE_AWARD_SQL,
  returnedRowsOf,
} from './quiz-badge-awarding.service';
import { QUIZ_BADGE_AWARD_LOCK_SQL } from './quiz-win-badges.constants';

describe('returnedRowsOf', () => {
  it('reads plain rows and the rows of an update or delete pair', () => {
    expect(returnedRowsOf<{ id: string }>([{ id: 'win-1' }])).toEqual([
      { id: 'win-1' },
    ]);
    expect(returnedRowsOf<{ id: string }>([[{ id: 'win-1' }], 1])).toEqual([
      { id: 'win-1' },
    ]);
    expect(returnedRowsOf([[], 0])).toEqual([]);
    expect(returnedRowsOf([])).toEqual([]);
    expect(returnedRowsOf(undefined)).toEqual([]);
  });
});

const WON_AT = new Date('2026-11-24T21:30:00.000Z');

function collapsed(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function awardInput(
  overrides: Partial<QuizBadgeAwardInput> = {},
): QuizBadgeAwardInput {
  return {
    definition: {
      id: 'def-1',
      badgeKey: 'quiz:def-1',
      nameEn: 'Quiz Night Champion',
      namePt: 'Campeã da noite de quiz',
    },
    userId: 'user-1',
    eventId: 'event-1',
    sessionId: 'session-1',
    gameNumber: 2,
    eventName: 'Pride Quiz Night',
    eventWasPublic: true,
    eventWasAdultsOnly: false,
    wonAt: WON_AT,
    ...overrides,
  };
}

function newWin(winId: string): QuizBadgeNewWin {
  return {
    winId,
    userId: 'user-1',
    badgeKey: 'quiz:def-1',
    badgeNameEn: 'Quiz Night Champion',
    badgeNamePt: 'Campeã da noite de quiz',
    eventName: 'Pride Quiz Night',
  };
}

describe('QuizBadgeAwardingService', () => {
  let manager: { query: jest.Mock };
  let notifications: { create: jest.Mock };
  let service: QuizBadgeAwardingService;

  beforeEach(() => {
    manager = { query: jest.fn() };
    notifications = { create: jest.fn().mockResolvedValue(null) };
    service = new QuizBadgeAwardingService(
      notifications as unknown as NotificationsService,
    );
  });

  function managerOf(): EntityManager {
    return manager as unknown as EntityManager;
  }

  it('writes the win, the award and the sync, and reports the new win', async () => {
    manager.query.mockImplementation((sql: string) =>
      Promise.resolve(
        sql === INSERT_QUIZ_BADGE_WIN_SQL ? [{ id: 'win-1' }] : [],
      ),
    );
    const awardedWin = await service.awardWin(
      managerOf(),
      awardInput({ eventWasAdultsOnly: true }),
    );
    expect(manager.query).toHaveBeenNthCalledWith(
      1,
      QUIZ_BADGE_AWARD_LOCK_SQL,
      ['user-1', 'quiz:def-1'],
    );
    expect(manager.query).toHaveBeenNthCalledWith(
      2,
      INSERT_QUIZ_BADGE_WIN_SQL,
      [
        'def-1',
        'user-1',
        'event-1',
        'session-1',
        2,
        'Pride Quiz Night',
        true,
        true,
        WON_AT,
      ],
    );
    expect(manager.query).toHaveBeenNthCalledWith(
      3,
      INSERT_QUIZ_BADGE_AWARD_SQL,
      ['user-1', 'quiz:def-1', true, WON_AT],
    );
    expect(manager.query).toHaveBeenNthCalledWith(
      4,
      SYNC_QUIZ_BADGE_AWARD_SQL,
      ['user-1', 'def-1', 'quiz:def-1'],
    );
    expect(manager.query).toHaveBeenCalledTimes(4);
    expect(awardedWin).toEqual({
      winId: 'win-1',
      userId: 'user-1',
      badgeKey: 'quiz:def-1',
      badgeNameEn: 'Quiz Night Champion',
      badgeNamePt: 'Campeã da noite de quiz',
      eventName: 'Pride Quiz Night',
    });
  });

  it('writes the award row visible for a win at an event open to every age', async () => {
    manager.query.mockImplementation((sql: string) =>
      Promise.resolve(
        sql === INSERT_QUIZ_BADGE_WIN_SQL ? [{ id: 'win-1' }] : [],
      ),
    );
    await service.awardWin(managerOf(), awardInput());
    expect(manager.query).toHaveBeenCalledWith(INSERT_QUIZ_BADGE_AWARD_SQL, [
      'user-1',
      'quiz:def-1',
      false,
      WON_AT,
    ]);
  });

  it('writes nothing more when the win already exists', async () => {
    manager.query.mockResolvedValue([]);
    await expect(
      service.awardWin(managerOf(), awardInput()),
    ).resolves.toBeNull();
    expect(manager.query).toHaveBeenCalledTimes(2);
    expect(manager.query).toHaveBeenNthCalledWith(
      1,
      QUIZ_BADGE_AWARD_LOCK_SQL,
      ['user-1', 'quiz:def-1'],
    );
    expect(manager.query).toHaveBeenNthCalledWith(
      2,
      INSERT_QUIZ_BADGE_WIN_SQL,
      expect.any(Array),
    );
  });

  it('skips a win that already exists for the same session, badge and member', () => {
    expect(collapsed(INSERT_QUIZ_BADGE_WIN_SQL)).toContain(
      'ON CONFLICT ("session_id", "badge_definition_id", "user_id") DO NOTHING RETURNING "id"',
    );
    expect(collapsed(INSERT_QUIZ_BADGE_AWARD_SQL)).toContain(
      'ON CONFLICT ("user_id", "badge_key") DO NOTHING',
    );
  });

  it('moves awarded_at to the earliest remaining win', () => {
    expect(collapsed(SYNC_QUIZ_BADGE_AWARD_SQL)).toContain(
      'SET "awarded_at" = "first"."won_at" FROM (SELECT MIN("win"."won_at")',
    );
    expect(collapsed(SYNC_QUIZ_BADGE_AWARD_SQL)).toContain(
      '"first"."won_at" IS NOT NULL',
    );
  });

  it('syncs the award row of one badge for one member', async () => {
    manager.query.mockResolvedValue([[], 1]);
    await service.syncAwardRow(managerOf(), 'user-1', {
      id: 'def-1',
      badgeKey: 'quiz:def-1',
    });
    expect(manager.query).toHaveBeenCalledWith(SYNC_QUIZ_BADGE_AWARD_SQL, [
      'user-1',
      'def-1',
      'quiz:def-1',
    ]);
  });

  it('deletes the award row with the last live win and keeps it with another', async () => {
    const deleteAwardAnswers: unknown[][] = [[{ badge_key: 'quiz:def-1' }], []];
    manager.query.mockImplementation((sql: string) => {
      if (sql === MARK_WINNER_REVOKED_SQL) {
        return Promise.resolve([
          { session_id: 'session-1', user_id: 'user-1', event_id: 'event-1' },
        ]);
      }
      if (sql === DELETE_GAME_WINS_SQL) {
        return Promise.resolve([
          { badge_definition_id: 'def-2' },
          { badge_definition_id: 'def-1' },
        ]);
      }
      if (sql === DELETE_AWARD_WITHOUT_WINS_SQL) {
        return Promise.resolve(deleteAwardAnswers.shift() ?? []);
      }
      return Promise.resolve([]);
    });
    const outcome = await service.revokeGameWin(managerOf(), {
      winnerId: 'winner-1',
      actorId: 'admin-1',
      reason: 'Host entered the wrong team',
    });
    expect(outcome).toEqual({
      userId: 'user-1',
      eventId: 'event-1',
      revokedBadgeKeys: ['quiz:def-1', 'quiz:def-2'],
      removedAwardKeys: ['quiz:def-1'],
    });
    expect(manager.query).toHaveBeenNthCalledWith(1, MARK_WINNER_REVOKED_SQL, [
      'winner-1',
      'admin-1',
      'Host entered the wrong team',
    ]);
    expect(manager.query).toHaveBeenNthCalledWith(2, DELETE_GAME_WINS_SQL, [
      'session-1',
      'user-1',
    ]);
    expect(manager.query).toHaveBeenNthCalledWith(
      3,
      QUIZ_BADGE_AWARD_LOCK_SQL,
      ['user-1', 'quiz:def-1'],
    );
    expect(manager.query).toHaveBeenNthCalledWith(
      4,
      DELETE_AWARD_WITHOUT_WINS_SQL,
      ['user-1', 'quiz:def-1', 'def-1'],
    );
    expect(manager.query).toHaveBeenNthCalledWith(
      5,
      QUIZ_BADGE_AWARD_LOCK_SQL,
      ['user-1', 'quiz:def-2'],
    );
    expect(manager.query).toHaveBeenNthCalledWith(
      6,
      DELETE_AWARD_WITHOUT_WINS_SQL,
      ['user-1', 'quiz:def-2', 'def-2'],
    );
    expect(manager.query).toHaveBeenNthCalledWith(
      7,
      SYNC_QUIZ_BADGE_AWARD_SQL,
      ['user-1', 'def-2', 'quiz:def-2'],
    );
    expect(manager.query).toHaveBeenNthCalledWith(
      8,
      DELETE_REVOKED_BADGE_NOTIFICATIONS_SQL,
      ['user-1', ['quiz:def-1']],
    );
    expect(manager.query).toHaveBeenCalledWith(SYNC_QUIZ_BADGE_AWARD_SQL, [
      'user-1',
      'def-2',
      'quiz:def-2',
    ]);
    expect(manager.query).not.toHaveBeenCalledWith(SYNC_QUIZ_BADGE_AWARD_SQL, [
      'user-1',
      'def-1',
      'quiz:def-1',
    ]);
    expect(manager.query).toHaveBeenCalledTimes(8);
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('keeps the bell as it is when every badge stays held through another win', async () => {
    manager.query.mockImplementation((sql: string) => {
      if (sql === MARK_WINNER_REVOKED_SQL) {
        return Promise.resolve([
          { session_id: 'session-1', user_id: 'user-1', event_id: 'event-1' },
        ]);
      }
      if (sql === DELETE_GAME_WINS_SQL) {
        return Promise.resolve([{ badge_definition_id: 'def-1' }]);
      }
      return Promise.resolve([]);
    });
    const outcome = await service.revokeGameWin(managerOf(), {
      winnerId: 'winner-1',
      actorId: 'admin-1',
      reason: 'Host entered the wrong team',
    });
    expect(outcome?.removedAwardKeys).toEqual([]);
    expect(manager.query).not.toHaveBeenCalledWith(
      DELETE_REVOKED_BADGE_NOTIFICATIONS_SQL,
      expect.any(Array),
    );
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('clears only the earned notifications of the removed badges of that member', () => {
    const notificationsSql = collapsed(DELETE_REVOKED_BADGE_NOTIFICATIONS_SQL);
    expect(notificationsSql).toContain('DELETE FROM "notifications"');
    expect(notificationsSql).toContain('"user_id" = $1');
    expect(notificationsSql).toContain(`"type" = 'badge_earned'`);
    expect(notificationsSql).toContain(
      `"payload" ->> 'badgeKey' = ANY($2::text[])`,
    );
  });

  it('reads the rows TypeORM returns as a pair from a Postgres update or delete', async () => {
    manager.query.mockImplementation((sql: string) => {
      if (sql === MARK_WINNER_REVOKED_SQL) {
        return Promise.resolve([
          [{ session_id: 'session-1', user_id: 'user-1', event_id: null }],
          1,
        ]);
      }
      if (sql === DELETE_GAME_WINS_SQL) {
        return Promise.resolve([[{ badge_definition_id: 'def-1' }], 1]);
      }
      if (sql === DELETE_AWARD_WITHOUT_WINS_SQL) {
        return Promise.resolve([[{ badge_key: 'quiz:def-1' }], 1]);
      }
      return Promise.resolve([]);
    });
    await expect(
      service.revokeGameWin(managerOf(), {
        winnerId: 'winner-1',
        actorId: 'admin-1',
        reason: 'Host entered the wrong team',
      }),
    ).resolves.toEqual({
      userId: 'user-1',
      eventId: null,
      revokedBadgeKeys: ['quiz:def-1'],
      removedAwardKeys: ['quiz:def-1'],
    });
    expect(manager.query).not.toHaveBeenCalledWith(
      SYNC_QUIZ_BADGE_AWARD_SQL,
      expect.any(Array),
    );
  });

  it('answers null when the winner is already revoked', async () => {
    manager.query.mockImplementation((sql: string) =>
      Promise.resolve(sql === MARK_WINNER_REVOKED_SQL ? [[], 0] : []),
    );
    await expect(
      service.revokeGameWin(managerOf(), {
        winnerId: 'winner-1',
        actorId: 'admin-1',
        reason: 'Host entered the wrong team',
      }),
    ).resolves.toBeNull();
    expect(manager.query).toHaveBeenCalledTimes(1);
    expect(manager.query).not.toHaveBeenCalledWith(
      DELETE_GAME_WINS_SQL,
      expect.any(Array),
    );
  });

  it('guards the revoke so a second admin matches nothing', () => {
    expect(collapsed(MARK_WINNER_REVOKED_SQL)).toContain(
      'WHERE "id" = $1 AND "revoked_at" IS NULL',
    );
    expect(collapsed(DELETE_AWARD_WITHOUT_WINS_SQL)).toContain('NOT EXISTS');
  });

  it('notifies each new win and survives one failure', async () => {
    notifications.create
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue(null);
    await service.notifyNewWins([newWin('win-1'), newWin('win-2')]);
    expect(notifications.create).toHaveBeenCalledTimes(2);
    expect(notifications.create).toHaveBeenLastCalledWith(
      'user-1',
      NotificationType.BadgeEarned,
      {
        badgeKey: 'quiz:def-1',
        badgeName: 'Quiz Night Champion',
        badgeNamePt: 'Campeã da noite de quiz',
        eventName: 'Pride Quiz Night',
      },
    );
  });

  it('never touches the XP tables', () => {
    for (const sql of [
      INSERT_QUIZ_BADGE_WIN_SQL,
      INSERT_QUIZ_BADGE_AWARD_SQL,
      SYNC_QUIZ_BADGE_AWARD_SQL,
      MARK_WINNER_REVOKED_SQL,
      DELETE_GAME_WINS_SQL,
      DELETE_AWARD_WITHOUT_WINS_SQL,
      DELETE_REVOKED_BADGE_NOTIFICATIONS_SQL,
      GAME_SLOT_DEFINITIONS_SQL,
      ELIGIBLE_WINNER_USER_IDS_SQL,
    ]) {
      expect(sql).not.toMatch(/recognition_stats|recognition_ledger/);
    }
  });

  it('reads the slots of one game in attach order and leaves suspended winners out', () => {
    expect(collapsed(GAME_SLOT_DEFINITIONS_SQL)).toContain(
      'WHERE "slot"."event_id" = $1 AND "slot"."game_number" = $2 ORDER BY "slot"."created_at" ASC, "slot"."id" ASC',
    );
    expect(collapsed(GAME_SLOT_DEFINITIONS_SQL)).not.toContain('archived');
    expect(collapsed(ELIGIBLE_WINNER_USER_IDS_SQL)).toContain(
      `"status" <> 'suspended'`,
    );
  });
});
