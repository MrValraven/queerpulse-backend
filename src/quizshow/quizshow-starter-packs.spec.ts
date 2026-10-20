import { isFeatureLaunched } from '../launchedFeatures';
import {
  QUIZSHOW_LIMITS,
  QUIZSHOW_STARTER_PACK_KEYS,
  type QuizshowQuestionType,
  type QuizshowStarterPack,
  type QuizshowStarterPackCard,
  type QuizshowStarterPackKey,
  type QuizshowText,
} from './quizshow.contract';
import {
  completenessProblems,
  hasAdultsRound,
  isPartyRoundKind,
  structuralProblems,
} from './quizshow-quiz-validation';
import {
  QUIZSHOW_STARTER_PACKS,
  QUIZSHOW_STARTER_PACKS_ARE_FACT_CHECKED,
  starterPackByKey,
  toStarterPackCard,
} from './quizshow-starter-packs';

const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const FORMAL_YOU_PATTERN = /\b[Vv]ocê/;

/** Every string anywhere under `value`, with whether it sits under a `pt` key. */
function collectStrings(
  value: unknown,
  isUnderPortugueseKey = false,
): Array<{ text: string; isPortuguese: boolean }> {
  if (typeof value === 'string') {
    return [{ text: value, isPortuguese: isUnderPortugueseKey }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectStrings(item, isUnderPortugueseKey));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([entryKey, entryValue]) =>
      collectStrings(entryValue, isUnderPortugueseKey || entryKey === 'pt'),
    );
  }
  return [];
}

/** The item at `index`, throwing when the list is shorter. */
function itemAt<Item>(items: readonly Item[], index: number): Item {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`Expected an item at index ${index}`);
  }
  return item;
}

function isFilled(text: QuizshowText): boolean {
  return text.en.trim().length > 0 && text.pt.trim().length > 0;
}

/** The four original packs, which share one three round, fifteen question shape. */
const CLASSIC_PACK_KEYS: readonly QuizshowStarterPackKey[] = [
  'pride_history',
  'portuguese_queer_culture',
  'eurovision',
  'drag_herstory',
];

/** The pack for `key`, throwing when the catalog has none. */
function packWithKey(key: QuizshowStarterPackKey): QuizshowStarterPack {
  const pack = starterPackByKey(key);
  if (pack === null) {
    throw new Error(`Expected a starter pack for ${key}`);
  }
  return pack;
}

function questionCountOf(pack: QuizshowStarterPack): number {
  return pack.quiz.rounds.reduce(
    (runningTotal, round) => runningTotal + round.questions.length,
    0,
  );
}

/** The round and question guarantees every pack keeps, whatever its shape. */
function expectSharedQuestionGuarantees(pack: QuizshowStarterPack): void {
  for (const round of pack.quiz.rounds) {
    expect(round.contentLabel).toBe('none');
    expect(round.settings).toEqual({
      timeLimitSeconds: 20,
      isSpeedBonusOn: true,
      isJokerAllowed: true,
      writeSeconds: 60,
      voteSeconds: 30,
    });
    for (const question of round.questions) {
      expect(question.points).toBe(1000);
      expect(question.timeLimitSeconds).toBeNull();
      if (question.type === 'multiple_choice') {
        expect(question.options.map((option) => option.id)).toEqual([
          'a',
          'b',
          'c',
          'd',
        ]);
      }
      if (question.type === 'order') {
        expect(question.options.map((option) => option.id)).toEqual([
          'a',
          'b',
          'c',
          'd',
        ]);
      }
      if (question.type === 'type_answer') {
        expect(question.acceptedAnswers.length).toBeLessThanOrEqual(3);
      }
      if (round.kind === 'drag_name') {
        expect(question.answer).toBeNull();
      }
    }
  }
}

describe('Pulse Live starter packs', () => {
  it('lists the packs in key order', () => {
    expect(QUIZSHOW_STARTER_PACKS.map((pack) => pack.key)).toEqual([
      ...QUIZSHOW_STARTER_PACK_KEYS,
    ]);
  });

  it('keeps every pack bilingual on the shared settings, points and option ids', () => {
    for (const pack of QUIZSHOW_STARTER_PACKS) {
      expect(pack.quiz.languages).toBe('both');
      expectSharedQuestionGuarantees(pack);
    }
  });

  it('gives every classic pack three rounds, fifteen questions and one party round', () => {
    const quizRoundOneTypes: QuizshowQuestionType[] = [
      'multiple_choice',
      'multiple_choice',
      'multiple_choice',
      'multiple_choice',
      'true_false',
      'true_false',
    ];
    const quizRoundTwoTypes: QuizshowQuestionType[] = [
      'type_answer',
      'type_answer',
      'order',
      'order',
      'closest_number',
      'closest_number',
    ];
    for (const key of CLASSIC_PACK_KEYS) {
      const pack = packWithKey(key);
      const rounds = pack.quiz.rounds;
      expect(rounds).toHaveLength(3);
      expect(questionCountOf(pack)).toBe(15);
      expect(
        rounds.filter((round) => isPartyRoundKind(round.kind)),
      ).toHaveLength(1);
      const roundOne = itemAt(rounds, 0);
      const roundTwo = itemAt(rounds, 1);
      const roundThree = itemAt(rounds, 2);
      expect(roundOne.kind).toBe('quiz');
      expect(roundTwo.kind).toBe('quiz');
      expect(roundOne.questions.map((question) => question.type)).toEqual(
        quizRoundOneTypes,
      );
      expect(roundTwo.questions.map((question) => question.type)).toEqual(
        quizRoundTwoTypes,
      );
      expect(roundThree.kind).toBe(
        pack.key === 'drag_herstory' ? 'drag_name' : 'lie_detector',
      );
      expect(roundThree.questions).toHaveLength(3);
    }
    expect(
      starterPackByKey('portuguese_queer_culture')?.quiz.screenLanguage,
    ).toBe('pt');
    for (const key of ['pride_history', 'eurovision', 'drag_herstory']) {
      expect(starterPackByKey(key)?.quiz.screenLanguage).toBe('en');
    }
  });

  it('gives the Lisbon pack three quiz rounds and a closing lie detector round on a Portuguese screen', () => {
    const pack = packWithKey('lisbon_queer_icons');
    const rounds = pack.quiz.rounds;
    const expectedQuestionTypesByRound: QuizshowQuestionType[][] = [
      [
        'multiple_choice',
        'multiple_choice',
        'multiple_choice',
        'multiple_choice',
        'true_false',
        'true_false',
      ],
      [
        'multiple_choice',
        'multiple_choice',
        'multiple_choice',
        'true_false',
        'true_false',
        'type_answer',
        'type_answer',
      ],
      [
        'type_answer',
        'order',
        'order',
        'order',
        'closest_number',
        'closest_number',
      ],
      ['prompt', 'prompt', 'prompt', 'prompt'],
    ];
    expect(rounds.map((round) => round.kind)).toEqual([
      'quiz',
      'quiz',
      'quiz',
      'lie_detector',
    ]);
    expect(
      rounds.map((round) => round.questions.map((question) => question.type)),
    ).toEqual(expectedQuestionTypesByRound);
    expect(questionCountOf(pack)).toBe(23);
    expect(rounds.filter((round) => isPartyRoundKind(round.kind))).toHaveLength(
      1,
    );
    expect(isPartyRoundKind(itemAt(rounds, rounds.length - 1).kind)).toBe(true);
    expect(pack.quiz.screenLanguage).toBe('pt');
  });

  it('passes the structural and the completeness checks', () => {
    for (const pack of QUIZSHOW_STARTER_PACKS) {
      expect(structuralProblems(pack.quiz)).toEqual([]);
      expect(completenessProblems(pack.quiz)).toEqual([]);
    }
  });

  it('holds no adults round and no image', () => {
    for (const pack of QUIZSHOW_STARTER_PACKS) {
      expect(hasAdultsRound(pack.quiz)).toBe(false);
      for (const round of pack.quiz.rounds) {
        for (const question of round.questions) {
          expect(question.mediaRef).toBeNull();
        }
      }
    }
  });

  it('fills every prompt, option and truth in both languages', () => {
    for (const pack of QUIZSHOW_STARTER_PACKS) {
      expect(isFilled(pack.title)).toBe(true);
      expect(isFilled(pack.description)).toBe(true);
      expect(pack.quiz.title.length).toBeLessThanOrEqual(
        QUIZSHOW_LIMITS.quizTitleMax,
      );
      for (const round of pack.quiz.rounds) {
        expect(isFilled(round.title)).toBe(true);
        for (const question of round.questions) {
          expect(isFilled(question.prompt)).toBe(true);
          expect(question.prompt.en.length).toBeLessThanOrEqual(
            QUIZSHOW_LIMITS.promptMax,
          );
          expect(question.prompt.pt.length).toBeLessThanOrEqual(
            QUIZSHOW_LIMITS.promptMax,
          );
          for (const option of question.options) {
            expect(isFilled(option.text)).toBe(true);
            expect(option.text.en.length).toBeLessThanOrEqual(
              QUIZSHOW_LIMITS.optionTextMax,
            );
            expect(option.text.pt.length).toBeLessThanOrEqual(
              QUIZSHOW_LIMITS.optionTextMax,
            );
          }
          if (round.kind === 'lie_detector') {
            expect(question.type).toBe('prompt');
            const truth =
              question.type === 'prompt' && question.answer !== null
                ? question.answer.truth
                : null;
            expect(truth).not.toBeNull();
            if (truth !== null) {
              expect(isFilled(truth)).toBe(true);
              expect(truth.en.length).toBeLessThanOrEqual(
                QUIZSHOW_LIMITS.answerTextMax,
              );
              expect(truth.pt.length).toBeLessThanOrEqual(
                QUIZSHOW_LIMITS.answerTextMax,
              );
            }
          }
        }
      }
    }
  });

  it('keeps dashes and the formal you out of every string', () => {
    const allStrings = collectStrings(QUIZSHOW_STARTER_PACKS);
    expect(allStrings.length).toBeGreaterThan(0);
    for (const { text, isPortuguese } of allStrings) {
      expect(text.includes(EM_DASH)).toBe(false);
      expect(text.includes(EN_DASH)).toBe(false);
      if (isPortuguese) {
        expect(FORMAL_YOU_PATTERN.test(text)).toBe(false);
      }
    }
    expect(allStrings.some(({ isPortuguese }) => isPortuguese)).toBe(true);
  });

  it('builds cards with no questions or answers', () => {
    const cardKeys: Array<keyof QuizshowStarterPackCard> = [
      'description',
      'hasAdultsRounds',
      'key',
      'languages',
      'questionCount',
      'roundCount',
      'title',
    ];
    for (const pack of QUIZSHOW_STARTER_PACKS) {
      const card = toStarterPackCard(pack);
      expect(Object.keys(card).sort()).toEqual(cardKeys);
      expect(card.key).toBe(pack.key);
      expect(card.title).toEqual(pack.title);
      expect(card.description).toEqual(pack.description);
      expect(card.languages).toBe('both');
      expect(card.hasAdultsRounds).toBe(false);
      expect(card.questionCount).toBe(questionCountOf(pack));
      expect(card.roundCount).toBe(pack.quiz.rounds.length);
    }
  });

  it('keeps Pulse Live hidden until the packs are fact-checked', () => {
    expect(typeof QUIZSHOW_STARTER_PACKS_ARE_FACT_CHECKED).toBe('boolean');
    if (isFeatureLaunched('quizshow')) {
      expect(QUIZSHOW_STARTER_PACKS_ARE_FACT_CHECKED).toBe(true);
    }
  });

  it('finds a pack by key and nothing for an unknown key', () => {
    for (const key of QUIZSHOW_STARTER_PACK_KEYS) {
      expect(starterPackByKey(key)?.key).toBe(key);
    }
    expect(starterPackByKey('karaoke_classics')).toBeNull();
    expect(starterPackByKey('')).toBeNull();
  });
});
