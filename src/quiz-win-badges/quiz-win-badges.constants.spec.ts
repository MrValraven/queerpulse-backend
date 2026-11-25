import {
  QUIZ_BADGE_AUDIT_ACTIONS,
  QUIZ_BADGE_AWARD_LOCK_SQL,
  QUIZ_EVENT_BADGES_LOCK_SQL,
  QUIZ_WIN_BADGE_REFUSALS,
  QUIZ_WIN_BADGE_REFUSAL_EXTRAS,
  quizBadgeAuditNote,
  quizBadgeDefinitionAuditNote,
  quizWinBadgeError,
} from './quiz-win-badges.constants';

describe('quiz win badge refusals', () => {
  it('answers a taken Portuguese name with 409 and the language', () => {
    const error = quizWinBadgeError('quiz_badge_name_taken', {
      language: 'pt',
    });
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toEqual({
      statusCode: 409,
      code: 'quiz_badge_name_taken',
      language: 'pt',
      message:
        'Another badge already uses this Portuguese name. Pick a different one.',
    });
  });

  it('writes English for the en language', () => {
    expect(
      quizWinBadgeError('quiz_badge_name_too_long', {
        language: 'en',
        maxLength: 40,
      }).getResponse(),
    ).toEqual({
      statusCode: 400,
      code: 'quiz_badge_name_too_long',
      language: 'en',
      maxLength: 40,
      message: 'Badge names fit in 40 characters. Shorten the English name.',
    });
  });

  it('names the holder count on an in-use delete', () => {
    expect(
      quizWinBadgeError('quiz_badge_in_use', { holderCount: 4 }).getResponse(),
    ).toEqual(
      expect.objectContaining({
        statusCode: 409,
        holderCount: 4,
        message: '4 members hold this badge, so it can only be archived.',
      }),
    );
  });

  it('fills the game number and limit of a full slot', () => {
    expect(
      quizWinBadgeError('quiz_badge_slot_limit_reached', {
        gameNumber: 2,
        limit: 3,
      }).getResponse(),
    ).toEqual({
      statusCode: 400,
      code: 'quiz_badge_slot_limit_reached',
      gameNumber: 2,
      limit: 3,
      message: 'Game 2 already gives 3 badges, the most one game can give.',
    });
  });

  it('names the field of an unreadable text', () => {
    expect(
      quizWinBadgeError('quiz_badge_text_invalid', {
        field: 'description.pt',
      }).getResponse(),
    ).toEqual(
      expect.objectContaining({
        field: 'description.pt',
        message:
          'The description.pt could not be read as text. Retype it and save again.',
      }),
    );
  });

  it('leaves a placeholder as written when its extra is absent', () => {
    expect(
      quizWinBadgeError('quiz_badge_winner_already_revoked').getResponse(),
    ).toEqual({
      statusCode: 409,
      code: 'quiz_badge_winner_already_revoked',
      message:
        'Another admin already revoked this win on {revokedAt}. Reload the page to see it.',
    });
  });

  it('carries the revoke time on an already revoked win', () => {
    expect(
      quizWinBadgeError('quiz_badge_winner_already_revoked', {
        revokedAt: '2026-11-24T10:00:00.000Z',
      }).getResponse(),
    ).toEqual(
      expect.objectContaining({
        revokedAt: '2026-11-24T10:00:00.000Z',
        message:
          'Another admin already revoked this win on 2026-11-24T10:00:00.000Z. Reload the page to see it.',
      }),
    );
  });

  it('drops extras a code does not list', () => {
    expect(
      quizWinBadgeError('quiz_badge_icon_unknown', { limit: 3 }).getResponse(),
    ).toEqual({
      statusCode: 400,
      code: 'quiz_badge_icon_unknown',
      message:
        'That icon is outside the badge icon set. Pick one from the list.',
    });
  });

  it('gives each of the 23 codes its status and copy', () => {
    expect(Object.keys(QUIZ_WIN_BADGE_REFUSALS)).toHaveLength(23);
    expect(Object.keys(QUIZ_WIN_BADGE_REFUSAL_EXTRAS).sort()).toEqual(
      Object.keys(QUIZ_WIN_BADGE_REFUSALS).sort(),
    );
    expect(QUIZ_WIN_BADGE_REFUSALS.quiz_badge_winner_not_found.status).toBe(
      404,
    );
    expect(QUIZ_WIN_BADGE_REFUSALS.quiz_badge_slot_limit_reached.status).toBe(
      400,
    );
    expect(QUIZ_WIN_BADGE_REFUSALS.quiz_badge_archived.status).toBe(409);
  });

  it('pins the seven audit codes and the lock statement', () => {
    expect(Object.values(QUIZ_BADGE_AUDIT_ACTIONS)).toEqual([
      'quiz_badge_attached',
      'quiz_badge_detached',
      'quiz_badge_awarded_after_game',
      'quiz_game_win_revoked',
      'quiz_badge_definition_archived',
      'quiz_badge_definition_restored',
      'quiz_badge_definition_deleted',
    ]);
    expect(QUIZ_EVENT_BADGES_LOCK_SQL).toBe(
      "SELECT pg_advisory_xact_lock(hashtext('quiz_event_badges:' || $1))",
    );
    expect(QUIZ_BADGE_AWARD_LOCK_SQL).toBe(
      "SELECT pg_advisory_xact_lock(hashtext('quiz_badge_award:' || $1 || ':' || $2))",
    );
    expect(
      quizBadgeAuditNote('Quiz Night Champion', 'def-1', 2, 'event-1'),
    ).toBe('Quiz Night Champion (def-1), game 2, event event-1');
    expect(quizBadgeDefinitionAuditNote('Quiz Night Champion', 'def-1')).toBe(
      'Quiz Night Champion (def-1)',
    );
  });
});
