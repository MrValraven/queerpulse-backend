import {
  QUIZ_BADGE_CATEGORY,
  QUIZ_BADGE_DESCRIPTION_MAX_LENGTH,
  QUIZ_BADGE_KEY_PREFIX,
  QUIZ_BADGE_NAME_MAX_LENGTH,
  QUIZ_BADGE_RARITIES,
  QUIZ_BADGE_TINTS,
  QUIZ_BADGE_WINS_PER_BADGE_MAX,
  QUIZ_BADGES_PER_GAME_MAX,
  QUIZ_EVENT_GAME_SLOTS_MAX,
  QUIZ_EVENT_SEARCH_MAX_LENGTH,
  QUIZ_REVOKE_REASON_MAX_LENGTH,
  isQuizBadgeKey,
  quizBadgeKeyOf,
  quizWinBadgeChipOf,
} from './quiz-win-badges.contract';

describe('quiz win badges contract', () => {
  it('recognises only prefixed keys as quiz badges', () => {
    expect(isQuizBadgeKey('quiz:7d1c0b52-3b1e-4d2f-9a51-0c6a1e1c2f10')).toBe(
      true,
    );
    expect(isQuizBadgeKey('first-gathering')).toBe(false);
  });

  it('pins the limits', () => {
    expect([
      QUIZ_EVENT_GAME_SLOTS_MAX,
      QUIZ_BADGES_PER_GAME_MAX,
      QUIZ_BADGE_NAME_MAX_LENGTH,
      QUIZ_BADGE_DESCRIPTION_MAX_LENGTH,
      QUIZ_REVOKE_REASON_MAX_LENGTH,
      QUIZ_EVENT_SEARCH_MAX_LENGTH,
      QUIZ_BADGE_WINS_PER_BADGE_MAX,
    ]).toEqual([5, 3, 40, 140, 300, 100, 100]);
    expect(QUIZ_BADGE_CATEGORY).toBe('Quiz nights');
  });

  it('pins the prefix, the tints and the rarities', () => {
    expect(QUIZ_BADGE_KEY_PREFIX).toBe('quiz:');
    expect([...QUIZ_BADGE_TINTS]).toEqual(['jade', 'accent', 'plum']);
    expect([...QUIZ_BADGE_RARITIES]).toEqual(['common', 'rare', 'legendary']);
  });

  it('builds the award key from a definition id', () => {
    expect(quizBadgeKeyOf('def-1')).toBe('quiz:def-1');
    expect(isQuizBadgeKey(quizBadgeKeyOf('def-1'))).toBe(true);
  });

  it('maps a definition to its chip with the archived flag', () => {
    expect(
      quizWinBadgeChipOf({
        id: 'def-1',
        badgeKey: 'quiz:def-1',
        nameEn: 'Quiz Night Champion',
        namePt: null,
        iconKey: 'star',
        tint: 'plum',
        rarity: 'legendary',
        archivedAt: new Date('2026-11-01T00:00:00Z'),
      }),
    ).toEqual({
      definitionId: 'def-1',
      badgeKey: 'quiz:def-1',
      name: { en: 'Quiz Night Champion', pt: null },
      iconKey: 'star',
      tint: 'plum',
      rarity: 'legendary',
      isArchived: true,
    });
  });

  it('marks a live definition as not archived', () => {
    expect(
      quizWinBadgeChipOf({
        id: 'def-2',
        badgeKey: 'quiz:def-2',
        nameEn: 'Runner Up',
        namePt: 'Segundo lugar',
        iconKey: 'star',
        tint: 'jade',
        rarity: 'common',
        archivedAt: null,
      }),
    ).toEqual(
      expect.objectContaining({
        isArchived: false,
        name: { en: 'Runner Up', pt: 'Segundo lugar' },
      }),
    );
  });
});
