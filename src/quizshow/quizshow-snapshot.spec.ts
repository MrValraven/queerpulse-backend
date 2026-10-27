import {
  QUIZSHOW_JOIN_CODE_PATTERN,
  type QuizshowOption,
  type QuizshowQuestion,
  type QuizshowQuiz,
  type QuizshowRound,
  type QuizshowRoundKind,
  type QuizshowRoundSettings,
} from './quizshow.contract';
import {
  buildSessionSnapshot,
  extraTimeMs,
  generateJoinCode,
  isLastQuestionOfRound,
  isLastRound,
  openLimitMs,
  type QuizshowRandom,
  questionCount,
  shuffleAvoidingOrder,
  snapshotQuestionAt,
  toAnswerKeyView,
  toHostQuestionView,
  toQuestionView,
  toRoundCard,
  voteLimitMs,
  writeLimitMs,
} from './quizshow-snapshot';

function at<Item>(items: readonly Item[], index: number): Item {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`missing item at index ${index}`);
  }
  return item;
}

function seededRandom(seed: number): QuizshowRandom {
  let state = seed;
  const next = (): number => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state;
  };
  return {
    uuid: () => `uuid-${next()}`,
    integerBelow: (limit: number) => next() % limit,
  };
}

/** Each shuffle step picks the last index, so the shuffle is the identity. */
const IDENTITY_RANDOM: QuizshowRandom = {
  uuid: () => 'uuid',
  integerBelow: (limit: number) => limit - 1,
};

const SETTINGS: QuizshowRoundSettings = {
  timeLimitSeconds: 20,
  isSpeedBonusOn: true,
  isJokerAllowed: true,
  writeSeconds: 60,
  voteSeconds: 30,
};

function text(value: string): { en: string; pt: string } {
  return { en: value, pt: value };
}

function options(ids: string[]): QuizshowOption[] {
  return ids.map((id) => ({ id, text: text(`option ${id}`) }));
}

const BASE = {
  prompt: text('prompt'),
  mediaRef: null,
  mediaUrl: null,
  timeLimitSeconds: null,
  points: 1000,
};

const MULTIPLE_CHOICE: QuizshowQuestion = {
  ...BASE,
  id: 'q-mc',
  type: 'multiple_choice',
  options: options(['a', 'b', 'c', 'd']),
  answer: { correctIndex: 2 },
  acceptedAnswers: [],
};
const TRUE_FALSE: QuizshowQuestion = {
  ...BASE,
  id: 'q-tf',
  type: 'true_false',
  options: [],
  answer: { isTrue: true },
  acceptedAnswers: [],
};
const TYPE_ANSWER: QuizshowQuestion = {
  ...BASE,
  id: 'q-ta',
  type: 'type_answer',
  options: [],
  answer: { text: text('Stonewall') },
  acceptedAnswers: ['Stonewall Inn'],
};
const ORDER: QuizshowQuestion = {
  ...BASE,
  id: 'q-or',
  type: 'order',
  options: options(['a', 'b', 'c', 'd']),
  answer: { orderedIds: ['a', 'b', 'c', 'd'] },
  acceptedAnswers: [],
};
const CLOSEST: QuizshowQuestion = {
  ...BASE,
  id: 'q-cn',
  type: 'closest_number',
  options: [],
  answer: { value: 1969 },
  acceptedAnswers: [],
  timeLimitSeconds: 15,
};
const LIE_DETECTOR: QuizshowQuestion = {
  ...BASE,
  id: 'q-ld',
  type: 'prompt',
  options: [],
  answer: { truth: text('the secret truth') },
  acceptedAnswers: [],
};
const CAPTION: QuizshowQuestion = {
  ...BASE,
  id: 'q-ct',
  type: 'prompt',
  options: [],
  answer: null,
  acceptedAnswers: [],
};

function round(
  kind: QuizshowRoundKind,
  questions: QuizshowQuestion[],
  id: string,
): QuizshowRound {
  return {
    id,
    kind,
    title: text(id),
    contentLabel: 'none',
    settings: { ...SETTINGS },
    questions,
  };
}

function buildQuiz(): QuizshowQuiz {
  return {
    title: 'Quiz night',
    languages: 'both',
    screenLanguage: 'en',
    sourceTemplateId: null,
    updatedAt: '2026-10-19T10:00:00.000Z',
    rounds: [
      round(
        'quiz',
        [MULTIPLE_CHOICE, TRUE_FALSE, TYPE_ANSWER, ORDER, CLOSEST],
        'r1',
      ),
      round('lie_detector', [LIE_DETECTOR], 'r2'),
      round('caption_this', [CAPTION], 'r3'),
    ].map((entry) => structuredClone(entry)),
  };
}

const FORBIDDEN_KEYS = ['answer', 'answerKey', 'acceptedAnswers', 'truth'];

function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, keys));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      keys.push(key);
      collectKeys(nested, keys);
    }
  }
  return keys;
}

describe('quizshow snapshot', () => {
  it('freezes the quiz with new references', () => {
    const quiz = buildQuiz();
    const snapshot = buildSessionSnapshot(quiz, seededRandom(1));
    const before = JSON.stringify(snapshot);

    quiz.title = 'Changed';
    at(quiz.rounds, 0).title.en = 'Changed';
    at(at(quiz.rounds, 0).questions, 0).prompt.en = 'Changed';
    at(at(at(quiz.rounds, 0).questions, 0).options, 0).text.en = 'Changed';
    quiz.rounds.pop();

    expect(JSON.stringify(snapshot)).toBe(before);
    expect(at(snapshot.rounds, 0)).not.toBe(at(quiz.rounds, 0));
  });

  it('keeps multiple choice options in authored order', () => {
    const snapshot = buildSessionSnapshot(buildQuiz(), seededRandom(7));
    const shown = at(at(snapshot.rounds, 0).questions, 0).shownOptions;
    expect(shown?.map((option) => option.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('gives every other question type no shown options', () => {
    const snapshot = buildSessionSnapshot(buildQuiz(), seededRandom(7));
    expect(at(at(snapshot.rounds, 0).questions, 1).shownOptions).toBeNull();
    expect(at(at(snapshot.rounds, 0).questions, 2).shownOptions).toBeNull();
    expect(at(at(snapshot.rounds, 0).questions, 4).shownOptions).toBeNull();
    expect(at(at(snapshot.rounds, 1).questions, 0).shownOptions).toBeNull();
  });

  it('never shows an order question in its correct order', () => {
    const rotated = shuffleAvoidingOrder(
      ['a', 'b', 'c', 'd'],
      ['a', 'b', 'c', 'd'],
      IDENTITY_RANDOM,
    );
    expect(rotated).toEqual(['b', 'c', 'd', 'a']);

    for (let seed = 1; seed <= 500; seed += 1) {
      const snapshot = buildSessionSnapshot(buildQuiz(), seededRandom(seed));
      const shownIds = at(
        at(snapshot.rounds, 0).questions,
        3,
      ).shownOptions?.map((option) => option.id);
      expect(shownIds).toHaveLength(4);
      expect(shownIds).not.toEqual(['a', 'b', 'c', 'd']);
    }
  });

  it('gives the screen and players a question view with no answer key', () => {
    const snapshot = buildSessionSnapshot(buildQuiz(), seededRandom(3));
    snapshot.rounds.forEach((snapshotRound, roundIndex) => {
      snapshotRound.questions.forEach((question, questionIndex) => {
        const view = toQuestionView(
          snapshotRound,
          question,
          roundIndex,
          questionIndex,
        );
        const keys = collectKeys(view);
        FORBIDDEN_KEYS.forEach((forbidden) => {
          expect(keys).not.toContain(forbidden);
        });
        expect(JSON.stringify(view)).not.toContain('the secret truth');
        expect(view.questionId).toBe(question.id);
      });
    });
  });

  it('gives hosts the answer key and the Lie Detector truth', () => {
    const snapshot = buildSessionSnapshot(buildQuiz(), seededRandom(3));
    const multipleChoiceRound = at(snapshot.rounds, 0);
    expect(
      toHostQuestionView(
        multipleChoiceRound,
        at(multipleChoiceRound.questions, 0),
        0,
        0,
      ).answerKey,
    ).toEqual({ type: 'multiple_choice', correctIndex: 2 });
    expect(
      toAnswerKeyView(
        multipleChoiceRound,
        at(multipleChoiceRound.questions, 1),
      ),
    ).toEqual({ type: 'true_false', isTrue: true });
    expect(
      toAnswerKeyView(
        multipleChoiceRound,
        at(multipleChoiceRound.questions, 2),
      ),
    ).toEqual({
      type: 'type_answer',
      text: text('Stonewall'),
      acceptedAnswers: ['Stonewall Inn'],
    });
    expect(
      toAnswerKeyView(
        multipleChoiceRound,
        at(multipleChoiceRound.questions, 3),
      ),
    ).toEqual({ type: 'order', orderedIds: ['a', 'b', 'c', 'd'] });
    expect(
      toAnswerKeyView(
        multipleChoiceRound,
        at(multipleChoiceRound.questions, 4),
      ),
    ).toEqual({ type: 'closest_number', value: 1969 });

    const lieRound = at(snapshot.rounds, 1);
    expect(toAnswerKeyView(lieRound, at(lieRound.questions, 0))).toEqual({
      type: 'lie_detector',
      truth: text('the secret truth'),
    });

    const captionRound = at(snapshot.rounds, 2);
    expect(
      toAnswerKeyView(captionRound, at(captionRound.questions, 0)),
    ).toBeNull();
    expect(
      toHostQuestionView(captionRound, at(captionRound.questions, 0), 2, 0)
        .answerKey,
    ).toBeNull();
  });

  it('builds the round card and the effective question limit', () => {
    const snapshot = buildSessionSnapshot(buildQuiz(), seededRandom(3));
    expect(toRoundCard(at(snapshot.rounds, 0), 0)).toEqual({
      roundIndex: 0,
      kind: 'quiz',
      title: text('r1'),
      contentLabel: 'none',
      questionCount: 5,
      isJokerAllowed: true,
      isSpeedBonusOn: true,
    });
    const quizRound = at(snapshot.rounds, 0);
    expect(
      toQuestionView(quizRound, at(quizRound.questions, 4), 0, 4)
        .timeLimitSeconds,
    ).toBe(15);
    expect(
      toQuestionView(quizRound, at(quizRound.questions, 0), 0, 0)
        .timeLimitSeconds,
    ).toBe(20);
    const lieRound = at(snapshot.rounds, 1);
    expect(
      toQuestionView(lieRound, at(lieRound.questions, 0), 1, 0)
        .timeLimitSeconds,
    ).toBe(60);
  });

  it("uses the question's limit, then the round's", () => {
    expect(openLimitMs({ settings: SETTINGS }, { timeLimitSeconds: 15 })).toBe(
      15000,
    );
    expect(
      openLimitMs({ settings: SETTINGS }, { timeLimitSeconds: null }),
    ).toBe(20000);
    expect(writeLimitMs({ settings: SETTINGS })).toBe(60000);
    expect(voteLimitMs({ settings: SETTINGS })).toBe(30000);
  });

  it('rounds the extra-time limit to the millisecond', () => {
    expect(extraTimeMs(20000)).toBe(30000);
    expect(extraTimeMs(15333)).toBe(23000);
  });

  it('draws join codes from the unambiguous alphabet', () => {
    const random = seededRandom(99);
    for (let draw = 0; draw < 1000; draw += 1) {
      expect(QUIZSHOW_JOIN_CODE_PATTERN.test(generateJoinCode(random))).toBe(
        true,
      );
    }
  });

  it('counts questions and knows the last of a round and of the quiz', () => {
    const snapshot = buildSessionSnapshot(buildQuiz(), seededRandom(3));
    expect(questionCount(snapshot)).toBe(7);
    expect(isLastQuestionOfRound(snapshot, 0, 3)).toBe(false);
    expect(isLastQuestionOfRound(snapshot, 0, 4)).toBe(true);
    expect(isLastRound(snapshot, 1)).toBe(false);
    expect(isLastRound(snapshot, 2)).toBe(true);
    expect(snapshotQuestionAt(snapshot, 1, 0)?.id).toBe('q-ld');
    expect(snapshotQuestionAt(snapshot, 1, 1)).toBeNull();
    expect(snapshotQuestionAt(snapshot, 9, 0)).toBeNull();
  });
});
