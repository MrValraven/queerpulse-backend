import {
  QUIZSHOW_JOIN_CODE_PATTERN,
  QUIZSHOW_WHEEL_SETTINGS_DEFAULTS,
  type QuizshowOption,
  type QuizshowQuestion,
  type QuizshowQuiz,
  type QuizshowRound,
  type QuizshowRoundKind,
  type QuizshowRoundSettings,
} from './quizshow.contract';
import {
  buildSessionSnapshot,
  effectiveAnswerKey,
  extraTimeMs,
  generateJoinCode,
  isLastQuestionOfRound,
  normaliseStoredSnapshot,
  openLimitMs,
  type QuizshowRandom,
  type QuizshowSnapshotQuestion,
  questionCount,
  readPhaseMsFor,
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
  ...QUIZSHOW_WHEEL_SETTINGS_DEFAULTS,
  isWarmUp: false,
  talkSeconds: 0,
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
  mediaAlt: text(''),
  mediaReveal: 'instant' as const,
  revealNote: text('Fun fact'),
  numberUnit: text(''),
  timeLimitSeconds: null,
  points: 1000,
};

const MULTIPLE_CHOICE: QuizshowQuestion = {
  ...BASE,
  id: 'q-mc',
  type: 'multiple_choice',
  options: options(['a', 'b', 'c', 'd']),
  answer: { correctIndexes: [2] },
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
  answer: { value: 1969, tolerance: { mode: 'percent', amount: 10 } },
  acceptedAnswers: [],
  timeLimitSeconds: 15,
  numberUnit: text('year'),
};
const LIE_DETECTOR: QuizshowQuestion = {
  ...BASE,
  id: 'q-ld',
  type: 'prompt',
  options: [],
  answer: { truth: text('the secret truth') },
  acceptedAnswers: [],
};
const POLL: QuizshowQuestion = {
  ...BASE,
  id: 'q-po',
  type: 'poll',
  options: options(['c', 'a', 'b']),
  answer: null,
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
    sourceTemplate: null,
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
          'both',
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
        'both',
        null,
      ).answerKey,
    ).toEqual({ type: 'multiple_choice', correctIndexes: [2] });
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
    ).toEqual({
      type: 'closest_number',
      value: 1969,
      tolerance: { mode: 'percent', amount: 10 },
    });

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
      toHostQuestionView(
        captionRound,
        at(captionRound.questions, 0),
        2,
        0,
        'both',
        null,
      ).answerKey,
    ).toBeNull();
  });

  it('builds the round card and the effective question limit', () => {
    const snapshot = buildSessionSnapshot(buildQuiz(), seededRandom(3));
    expect(toRoundCard(at(snapshot.rounds, 0), 0, 'teams')).toEqual({
      roundIndex: 0,
      kind: 'quiz',
      title: text('r1'),
      contentLabel: 'none',
      questionCount: 5,
      isJokerAllowed: true,
      isSpeedBonusOn: true,
      isWarmUp: false,
      talkSeconds: 0,
    });
    const quizRound = at(snapshot.rounds, 0);
    expect(
      toQuestionView(quizRound, at(quizRound.questions, 4), 0, 4, 'both')
        .timeLimitSeconds,
    ).toBe(15);
    expect(
      toQuestionView(quizRound, at(quizRound.questions, 0), 0, 0, 'both')
        .timeLimitSeconds,
    ).toBe(20);
    const lieRound = at(snapshot.rounds, 1);
    expect(
      toQuestionView(lieRound, at(lieRound.questions, 0), 1, 0, 'both')
        .timeLimitSeconds,
    ).toBe(60);
  });

  it('gives a wheel row a plain round card with no joker', () => {
    const wheelRow = round('wheel', [], 'w1');
    wheelRow.contentLabel = 'spicy';
    wheelRow.settings = {
      ...SETTINGS,
      isJokerAllowed: true,
      isSpeedBonusOn: false,
    };
    const snapshot = buildSessionSnapshot(
      {
        ...buildQuiz(),
        rounds: [round('quiz', [MULTIPLE_CHOICE], 'r1'), wheelRow],
      },
      seededRandom(3),
    );
    expect(toRoundCard(at(snapshot.rounds, 1), 1, 'teams')).toEqual({
      roundIndex: 1,
      kind: 'wheel',
      title: text('w1'),
      contentLabel: 'none',
      questionCount: 0,
      isJokerAllowed: false,
      isSpeedBonusOn: false,
      isWarmUp: false,
      talkSeconds: 0,
    });
  });

  it('freezes a wheel row with its settings and no questions', () => {
    const wheelRow = round('wheel', [], 'w1');
    wheelRow.settings = { ...SETTINGS, wheelPick: 'question' };
    const snapshot = buildSessionSnapshot(
      {
        ...buildQuiz(),
        rounds: [
          round('quiz', [MULTIPLE_CHOICE], 'r1'),
          wheelRow,
          round('quiz', [TRUE_FALSE], 'r2'),
          round('quiz', [TYPE_ANSWER], 'r3'),
        ],
      },
      seededRandom(3),
    );
    expect(snapshot.rounds).toHaveLength(4);
    expect(at(snapshot.rounds, 1).questions).toEqual([]);
    expect(at(snapshot.rounds, 1).settings.wheelPick).toBe('question');
    expect(questionCount(snapshot)).toBe(3);
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

  it('counts questions and knows the last question of a round', () => {
    const snapshot = buildSessionSnapshot(buildQuiz(), seededRandom(3));
    expect(questionCount(snapshot)).toBe(7);
    expect(isLastQuestionOfRound(snapshot, 0, 3)).toBe(false);
    expect(isLastQuestionOfRound(snapshot, 0, 4)).toBe(true);
    expect(snapshotQuestionAt(snapshot, 1, 0)?.id).toBe('q-ld');
    expect(snapshotQuestionAt(snapshot, 1, 1)).toBeNull();
    expect(snapshotQuestionAt(snapshot, 9, 0)).toBeNull();
  });

  it('records the quiz version the snapshot was built from', () => {
    const snapshot = buildSessionSnapshot(buildQuiz(), seededRandom(3));
    expect(snapshot.sourceUpdatedAt).toBe('2026-10-19T10:00:00.000Z');
  });

  it('keeps poll options in authored order and gives a poll no key', () => {
    const snapshot = buildSessionSnapshot(
      { ...buildQuiz(), rounds: [round('quiz', [POLL], 'r1')] },
      seededRandom(7),
    );
    const pollRound = at(snapshot.rounds, 0);
    const poll = at(pollRound.questions, 0);
    expect(poll.shownOptions?.map((option) => option.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
    expect(toAnswerKeyView(pollRound, poll)).toBeNull();
    expect(
      toHostQuestionView(pollRound, poll, 0, 0, 'both', null).answerKey,
    ).toBeNull();
  });

  describe('read phase length', () => {
    function readQuestion(
      promptEn: string,
      promptPt: string,
      authoredOptions: QuizshowOption[] = [],
      shownOptions: QuizshowOption[] | null = null,
    ): QuizshowSnapshotQuestion {
      return {
        ...BASE,
        id: 'q-read',
        type: 'order',
        prompt: { en: promptEn, pt: promptPt },
        options: authoredOptions,
        answer: null,
        acceptedAnswers: [],
        shownOptions,
      };
    }

    function letters(count: number): string {
      return 'x'.repeat(count);
    }

    it('starts at the 3000 ms floor for an empty prompt', () => {
      expect(readPhaseMsFor(readQuestion('', ''), 'en')).toBe(3000);
    });

    it('adds 25 ms per character over the 1500 ms base', () => {
      expect(
        readPhaseMsFor(readQuestion(letters(200), letters(200)), 'en'),
      ).toBe(6500);
    });

    it('stops at the 8000 ms ceiling', () => {
      expect(
        readPhaseMsFor(readQuestion(letters(400), letters(400)), 'pt'),
      ).toBe(8000);
    });

    it('takes the longer language when the screen shows both', () => {
      const question = readQuestion(letters(100), letters(200));
      expect(readPhaseMsFor(question, 'both')).toBe(6500);
      expect(readPhaseMsFor(question, 'en')).toBe(4000);
    });

    it('counts the shown options of an order question', () => {
      const authored = [
        { id: 'a', text: text(letters(40)) },
        { id: 'b', text: text(letters(40)) },
      ];
      const shown = [
        { id: 'b', text: text(letters(80)) },
        { id: 'a', text: text(letters(80)) },
      ];
      expect(
        readPhaseMsFor(readQuestion(letters(40), letters(40), authored), 'en'),
      ).toBe(4500);
      expect(
        readPhaseMsFor(
          readQuestion(letters(40), letters(40), authored, shown),
          'en',
        ),
      ).toBe(6500);
    });

    it('sends the read length on a quiz question and 0 on a party question', () => {
      const snapshot = buildSessionSnapshot(buildQuiz(), seededRandom(3));
      const quizRound = at(snapshot.rounds, 0);
      const quizQuestion = at(quizRound.questions, 0);
      expect(toQuestionView(quizRound, quizQuestion, 0, 0, 'both').readMs).toBe(
        readPhaseMsFor(quizQuestion, 'both'),
      );
      const lieRound = at(snapshot.rounds, 1);
      expect(
        toQuestionView(lieRound, at(lieRound.questions, 0), 1, 0, 'both')
          .readMs,
      ).toBe(0);
    });
  });

  it('gives a talk beat in teams play and none in solo play', () => {
    const talkRound = round('quiz', [MULTIPLE_CHOICE], 'r1');
    talkRound.settings = { ...SETTINGS, isWarmUp: true, talkSeconds: 20 };
    const snapshot = buildSessionSnapshot(
      { ...buildQuiz(), rounds: [talkRound] },
      seededRandom(3),
    );
    const teamsCard = toRoundCard(at(snapshot.rounds, 0), 0, 'teams');
    expect(teamsCard.talkSeconds).toBe(20);
    expect(teamsCard.isWarmUp).toBe(true);
    expect(toRoundCard(at(snapshot.rounds, 0), 0, 'solo').talkSeconds).toBe(0);
  });

  it('shows the reveal note to hosts and keeps it off the public view', () => {
    const snapshot = buildSessionSnapshot(buildQuiz(), seededRandom(3));
    const quizRound = at(snapshot.rounds, 0);
    const closest = at(quizRound.questions, 4);
    const view = toQuestionView(quizRound, closest, 0, 4, 'both');
    expect('revealNote' in view).toBe(false);
    expect(view.numberUnit).toEqual(text('year'));
    expect(view.mediaReveal).toBe('instant');
    expect(view.mediaAlt).toEqual(text(''));
    expect(
      toHostQuestionView(quizRound, closest, 0, 4, 'both', null).revealNote,
    ).toEqual(text('Fun fact'));
  });

  it('judges by the host correction when there is one', () => {
    const snapshot = buildSessionSnapshot(buildQuiz(), seededRandom(3));
    const quizRound = at(snapshot.rounds, 0);
    const multipleChoice = at(quizRound.questions, 0);
    const correction = {
      type: 'multiple_choice' as const,
      correctIndexes: [1, 2],
    };
    expect(effectiveAnswerKey(quizRound, multipleChoice, correction)).toEqual(
      correction,
    );
    expect(effectiveAnswerKey(quizRound, multipleChoice, null)).toEqual({
      type: 'multiple_choice',
      correctIndexes: [2],
    });
    expect(
      toHostQuestionView(quizRound, multipleChoice, 0, 0, 'both', correction)
        .answerKey,
    ).toEqual(correction);
  });

  it('reads a snapshot stored before v2 as it was authored', () => {
    const storedOptions = options(['a', 'b', 'c']);
    const stored = {
      title: 'Old night',
      languages: 'en',
      screenLanguage: 'en',
      rounds: [
        {
          id: 'r1',
          kind: 'quiz',
          title: text('r1'),
          contentLabel: 'none',
          settings: {
            timeLimitSeconds: 20,
            isSpeedBonusOn: true,
            isJokerAllowed: true,
            writeSeconds: 60,
            voteSeconds: 30,
          },
          questions: [
            {
              id: 'q-mc',
              type: 'multiple_choice',
              prompt: text('prompt'),
              mediaRef: null,
              mediaUrl: null,
              timeLimitSeconds: null,
              points: 1000,
              options: storedOptions,
              answer: { correctIndex: 1 },
              acceptedAnswers: [],
              shownOptions: storedOptions,
            },
            {
              id: 'q-cn',
              type: 'closest_number',
              prompt: text('prompt'),
              mediaRef: null,
              mediaUrl: null,
              timeLimitSeconds: null,
              points: 1000,
              options: [],
              answer: { value: 1969 },
              acceptedAnswers: [],
              shownOptions: null,
            },
          ],
        },
      ],
    };
    const snapshot = normaliseStoredSnapshot(stored);
    expect(snapshot.sourceUpdatedAt).toBe('');
    expect(snapshot.screenLanguage).toBe('en');
    const storedRound = at(snapshot.rounds, 0);
    expect(storedRound.settings).toEqual(SETTINGS);
    const multipleChoice = at(storedRound.questions, 0);
    expect(multipleChoice.answer).toEqual({ correctIndexes: [1] });
    expect(multipleChoice.shownOptions).toEqual(storedOptions);
    expect(multipleChoice.mediaAlt).toEqual({ en: '', pt: '' });
    expect(multipleChoice.revealNote).toEqual({ en: '', pt: '' });
    expect(multipleChoice.numberUnit).toEqual({ en: '', pt: '' });
    expect(multipleChoice.mediaReveal).toBe('instant');
    expect(at(storedRound.questions, 1).answer).toEqual({
      value: 1969,
      tolerance: { mode: 'absolute', amount: 10 },
    });
    expect(normaliseStoredSnapshot(snapshot)).toEqual(snapshot);
  });

  it('reads a snapshot built after v2 unchanged', () => {
    const built = buildSessionSnapshot(buildQuiz(), seededRandom(3));
    const reread = normaliseStoredSnapshot(
      JSON.parse(JSON.stringify(built)) as unknown,
    );
    expect(reread).toEqual(built);
  });
});
