import {
  QUIZSHOW_WHEEL_SETTINGS_DEFAULTS,
  type QuizshowRoundSettings,
} from './quizshow.contract';
import {
  normaliseStoredQuestion,
  normaliseStoredRecap,
  withRoundSettingsDefaults,
} from './quizshow-stored-shapes';

const EMPTY_TEXT = { en: '', pt: '' };

function text(value: string): { en: string; pt: string } {
  return { en: value, pt: value };
}

/** A question as stored before v2: none of the four new fields. */
function storedQuestion(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: 'q-1',
    prompt: text('prompt'),
    mediaRef: null,
    mediaUrl: null,
    timeLimitSeconds: null,
    points: 1000,
    options: [],
    acceptedAnswers: [],
    ...overrides,
  };
}

const STORED_MULTIPLE_CHOICE = storedQuestion({
  type: 'multiple_choice',
  options: [
    { id: 'a', text: text('Ana') },
    { id: 'b', text: text('Bia') },
  ],
  answer: { correctIndex: 1 },
  shownOptions: [
    { id: 'a', text: text('Ana') },
    { id: 'b', text: text('Bia') },
  ],
});

const STORED_CLOSEST = storedQuestion({
  type: 'closest_number',
  answer: { value: 1969 },
});

const STORED_TYPE_ANSWER = storedQuestion({
  type: 'type_answer',
  answer: { text: text('Stonewall') },
  acceptedAnswers: ['Stonewall Inn'],
});

describe('quizshow stored shapes', () => {
  describe('normaliseStoredQuestion', () => {
    it('reads a stored single correct option as a list of one', () => {
      expect(normaliseStoredQuestion(STORED_MULTIPLE_CHOICE).answer).toEqual({
        correctIndexes: [1],
      });
    });

    it('reads a closest year without a tolerance as within 10 years before 1990', () => {
      expect(normaliseStoredQuestion(STORED_CLOSEST).answer).toEqual({
        value: 1969,
        tolerance: { mode: 'absolute', amount: 10 },
      });
    });

    it('reads a closest answer that is not a year as within 10 percent', () => {
      expect(
        normaliseStoredQuestion({
          ...STORED_CLOSEST,
          answer: { value: 42 },
        }).answer,
      ).toEqual({ value: 42, tolerance: { mode: 'percent', amount: 10 } });
    });

    it('fills the picture description, reveal note and number unit with empty text', () => {
      const question = normaliseStoredQuestion(STORED_TYPE_ANSWER);
      expect(question.mediaAlt).toEqual(EMPTY_TEXT);
      expect(question.revealNote).toEqual(EMPTY_TEXT);
      expect(question.numberUnit).toEqual(EMPTY_TEXT);
    });

    it('reads a missing picture reveal as instant', () => {
      expect(normaliseStoredQuestion(STORED_TYPE_ANSWER).mediaReveal).toBe(
        'instant',
      );
    });

    it('keeps a null multiple choice answer null', () => {
      const unfinished = storedQuestion({
        type: 'multiple_choice',
        options: [{ id: 'a', text: text('Ana') }],
        answer: null,
      });
      expect(normaliseStoredQuestion(unfinished).answer).toBeNull();
    });

    it('copies every other key as stored, id and shown options included', () => {
      const question = normaliseStoredQuestion(STORED_MULTIPLE_CHOICE);
      expect(question).toEqual({
        ...STORED_MULTIPLE_CHOICE,
        answer: { correctIndexes: [1] },
        mediaAlt: EMPTY_TEXT,
        mediaReveal: 'instant',
        revealNote: EMPTY_TEXT,
        numberUnit: EMPTY_TEXT,
      });
      expect(STORED_MULTIPLE_CHOICE.answer).toEqual({ correctIndex: 1 });
    });

    it('keeps the stored v2 fields and answers as they are', () => {
      const current = storedQuestion({
        type: 'closest_number',
        answer: { value: 42, tolerance: { mode: 'absolute', amount: 5 } },
        mediaAlt: text('A rainbow flag'),
        mediaReveal: 'slow',
        revealNote: text('Fun fact'),
        numberUnit: text('years'),
      });
      expect(normaliseStoredQuestion(current)).toEqual(current);
    });

    it('returns the same shape when run twice', () => {
      [STORED_MULTIPLE_CHOICE, STORED_CLOSEST, STORED_TYPE_ANSWER].forEach(
        (stored) => {
          const once = normaliseStoredQuestion(stored);
          expect(
            normaliseStoredQuestion(once as unknown as Record<string, unknown>),
          ).toEqual(once);
        },
      );
    });
  });

  describe('withRoundSettingsDefaults', () => {
    const STORED_SETTINGS: Partial<QuizshowRoundSettings> = {
      timeLimitSeconds: 20,
      isSpeedBonusOn: true,
      isJokerAllowed: true,
      writeSeconds: 60,
      voteSeconds: 30,
    };

    it('fills the wheel settings, warm-up off and no talk time', () => {
      expect(withRoundSettingsDefaults(STORED_SETTINGS)).toEqual({
        ...STORED_SETTINGS,
        ...QUIZSHOW_WHEEL_SETTINGS_DEFAULTS,
        isWarmUp: false,
        talkSeconds: 0,
      });
    });

    it('keeps stored values and leaves the input untouched', () => {
      const stored: Partial<QuizshowRoundSettings> = {
        ...STORED_SETTINGS,
        isWarmUp: true,
        talkSeconds: 30,
      };
      const before = { ...stored };
      const settings = withRoundSettingsDefaults(stored);
      expect(settings.isWarmUp).toBe(true);
      expect(settings.talkSeconds).toBe(30);
      expect(settings).not.toBe(stored);
      expect(stored).toEqual(before);
    });
  });

  describe('normaliseStoredRecap', () => {
    const STORED_RECAP = {
      questionsPlayed: 1,
      answersGiven: 4,
      questions: [
        {
          roundIndex: 0,
          questionIndex: 0,
          roundKind: 'quiz',
          type: 'multiple_choice',
          prompt: text('prompt'),
          answerCount: 4,
          percentCorrect: 50,
          averageAnswerMs: 4200,
          wasSkipped: false,
        },
      ],
    };

    it('reads a recap stored before v2 with no standings and no warm-up or corrected question', () => {
      const recap = normaliseStoredRecap(STORED_RECAP);
      expect(recap.standings).toEqual([]);
      expect(recap.questionsPlayed).toBe(1);
      expect(recap.answersGiven).toBe(4);
      expect(recap.questions).toEqual([
        {
          ...STORED_RECAP.questions[0],
          isWarmUp: false,
          wasCorrected: false,
        },
      ]);
    });

    it('keeps the standings and flags of a recap stored after v2', () => {
      const current = {
        ...STORED_RECAP,
        questions: STORED_RECAP.questions.map((question) => ({
          ...question,
          isWarmUp: true,
          wasCorrected: true,
        })),
        standings: [
          { rank: 1, kind: 'player', name: 'Ana', colorKey: null, score: 900 },
        ],
      };
      expect(normaliseStoredRecap(current)).toEqual(current);
      expect(normaliseStoredRecap(normaliseStoredRecap(current))).toEqual(
        current,
      );
    });
  });
});
