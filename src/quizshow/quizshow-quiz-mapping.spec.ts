import type { QuizshowQuestionRecord } from './entities/quizshow-question.entity';
import type { QuizshowQuizRecord } from './entities/quizshow-quiz.entity';
import type { QuizshowRoundRecord } from './entities/quizshow-round.entity';
import {
  buildRoundRows,
  normalisedScreenLanguage,
  toQuizShape,
  toQuizshowQuiz,
} from './quizshow-quiz-mapping';
import type { QuizshowValidatableQuiz } from './quizshow-quiz-validation';
import type {
  QuizshowQuestionInput,
  QuizshowRoundSettings,
} from './quizshow.contract';

type InputRound = QuizshowValidatableQuiz['rounds'][number];

const baseSettings = {
  timeLimitSeconds: 20,
  isSpeedBonusOn: true,
  isJokerAllowed: true,
  writeSeconds: 60,
  voteSeconds: 30,
};

const emptyText = { en: '', pt: '' };

const filledQuestion: QuizshowQuestionInput = {
  type: 'true_false',
  prompt: { en: 'Prompt', pt: 'Pergunta' },
  mediaRef: null,
  mediaAlt: emptyText,
  mediaReveal: 'instant',
  revealNote: emptyText,
  numberUnit: emptyText,
  timeLimitSeconds: null,
  points: 1000,
  options: [],
  answer: { isTrue: true },
  acceptedAnswers: [],
};

function inputRound(
  kind: InputRound['kind'],
  settings: Partial<QuizshowRoundSettings> = {},
  overrides: Partial<InputRound> = {},
): InputRound {
  return {
    kind,
    title: { en: 'Round', pt: 'Ronda' },
    contentLabel: 'none',
    settings: { ...baseSettings, ...settings } as InputRound['settings'],
    questions: kind === 'wheel' ? [] : [filledQuestion],
    ...overrides,
  };
}

const storedQuizRecord = {
  title: 'Quiz',
  languages: 'both',
  screenLanguage: 'en',
  sourceTemplateId: null,
  updatedAt: new Date('2026-11-09T10:00:00.000Z'),
} as unknown as QuizshowQuizRecord;

const storedQuizRoundRecord = {
  id: 'round-1',
  position: 0,
  kind: 'quiz',
  titleEn: 'Round',
  titlePt: 'Ronda',
  contentLabel: 'none',
  settings: baseSettings,
} as unknown as QuizshowRoundRecord;

function storedQuestionRecord(
  overrides: Record<string, unknown>,
): QuizshowQuestionRecord {
  return {
    id: 'question-1',
    roundId: 'round-1',
    position: 0,
    promptEn: 'Prompt',
    promptPt: 'Pergunta',
    mediaRef: null,
    mediaAltEn: '',
    mediaAltPt: '',
    mediaReveal: 'instant',
    revealNoteEn: '',
    revealNotePt: '',
    numberUnitEn: '',
    numberUnitPt: '',
    acceptedAnswers: [],
    timeLimitSeconds: null,
    points: 1000,
    ...overrides,
  } as unknown as QuizshowQuestionRecord;
}

function questionOf(overrides: Record<string, unknown>): QuizshowQuestionInput {
  return { ...filledQuestion, ...overrides };
}

describe('quiz mapping', () => {
  it('fills missing wheel settings on every saved row', () => {
    const quizRound = {
      ...inputRound('quiz'),
      settings: baseSettings,
    } as unknown as InputRound;
    const { rounds } = buildRoundRows('quiz-1', [quizRound]);
    expect(rounds[0]?.settings).toMatchObject({
      wheelBonus: 0,
      wheelPick: 'round',
      sliceCount: null,
    });
  });

  it('clears a bonus outside a range and forces wheel rows plain on save', () => {
    const { rounds, questions } = buildRoundRows('quiz-1', [
      inputRound('quiz', { wheelBonus: 500 }),
      inputRound('wheel', { wheelBonus: 500 }, { contentLabel: 'adults' }),
      inputRound('quiz', { wheelBonus: 250 }),
      inputRound('quiz'),
    ]);
    expect(rounds.map((row) => row.settings?.wheelBonus)).toEqual([
      0, 0, 250, 0,
    ]);
    expect(rounds[1]?.contentLabel).toBe('none');
    expect(rounds.map((row) => row.position)).toEqual([0, 1, 2, 3]);
    const wheelRowId = rounds[1]?.id;
    expect(questions.filter((row) => row.roundId === wheelRowId)).toEqual([]);
    expect(questions).toHaveLength(3);
  });

  it('defaults stored rows on read', () => {
    const quizRecord = {
      title: 'Quiz',
      languages: 'both',
      screenLanguage: 'en',
      sourceTemplateId: null,
      updatedAt: new Date('2026-11-09T10:00:00.000Z'),
    } as unknown as QuizshowQuizRecord;
    const roundRecord = {
      id: 'round-1',
      position: 0,
      kind: 'quiz',
      titleEn: 'Round',
      titlePt: 'Ronda',
      contentLabel: 'none',
      settings: baseSettings,
    } as unknown as QuizshowRoundRecord;
    const quiz = toQuizshowQuiz(quizRecord, [roundRecord], []);
    expect(quiz.rounds[0]?.settings).toMatchObject({
      ...baseSettings,
      wheelBonus: 0,
      wheelPick: 'round',
      sliceCount: null,
    });
  });

  it('keeps the wheel settings through an import shape', () => {
    const quizRecord = {
      title: 'Quiz',
      languages: 'both',
      screenLanguage: 'en',
      sourceTemplateId: null,
      updatedAt: new Date('2026-11-09T10:00:00.000Z'),
    } as unknown as QuizshowQuizRecord;
    const wheelRecord = {
      id: 'wheel-1',
      position: 0,
      kind: 'wheel',
      titleEn: '',
      titlePt: '',
      contentLabel: 'none',
      settings: { ...baseSettings, wheelPick: 'question', sliceCount: 3 },
    } as unknown as QuizshowRoundRecord;
    const shape = toQuizShape(toQuizshowQuiz(quizRecord, [wheelRecord], []));
    expect(shape.rounds[0]?.settings).toMatchObject({
      wheelPick: 'question',
      sliceCount: 3,
    });
  });
  it('reads stored rows with the old multiple choice and closest shapes in the v2 shape', () => {
    const multipleChoiceRecord = storedQuestionRecord({
      id: 'question-1',
      position: 0,
      type: 'multiple_choice',
      options: [
        { id: 'o1', text: { en: 'One', pt: 'Um' } },
        { id: 'o2', text: { en: 'Two', pt: 'Dois' } },
      ],
      answer: { correctIndex: 1 },
    });
    const closestRecord = storedQuestionRecord({
      id: 'question-2',
      position: 1,
      type: 'closest_number',
      options: [],
      answer: { value: 1969 },
    });
    const quiz = toQuizshowQuiz(
      storedQuizRecord,
      [storedQuizRoundRecord],
      [multipleChoiceRecord, closestRecord],
    );
    const [multipleChoice, closest] = quiz.rounds[0]?.questions ?? [];
    expect(multipleChoice?.answer).toEqual({ correctIndexes: [1] });
    expect(closest?.answer).toEqual({
      value: 1969,
      tolerance: { mode: 'percent', amount: 10 },
    });
    expect(multipleChoice).toMatchObject({
      id: 'question-1',
      mediaAlt: emptyText,
      mediaReveal: 'instant',
      revealNote: emptyText,
      numberUnit: emptyText,
    });
  });

  it('reads the v2 columns and the warm-up and talk settings', () => {
    const closestRecord = storedQuestionRecord({
      type: 'closest_number',
      options: [],
      answer: { value: 12, tolerance: { mode: 'absolute', amount: 2 } },
      mediaRef: 'event-cover/abc',
      mediaAltEn: 'A cake',
      mediaAltPt: 'Um bolo',
      mediaReveal: 'slow',
      revealNoteEn: 'Fun fact',
      revealNotePt: 'Curiosidade',
      numberUnitEn: 'years',
      numberUnitPt: 'anos',
    });
    const quiz = toQuizshowQuiz(
      storedQuizRecord,
      [storedQuizRoundRecord],
      [closestRecord],
    );
    expect(quiz.rounds[0]?.questions[0]).toMatchObject({
      mediaAlt: { en: 'A cake', pt: 'Um bolo' },
      mediaReveal: 'slow',
      revealNote: { en: 'Fun fact', pt: 'Curiosidade' },
      numberUnit: { en: 'years', pt: 'anos' },
      answer: { value: 12, tolerance: { mode: 'absolute', amount: 2 } },
    });
    expect(quiz.rounds[0]?.settings).toMatchObject({
      isWarmUp: false,
      talkSeconds: 0,
    });
    expect(quiz.sourceTemplate).toBeNull();
  });

  it('passes the source template the caller resolved through to the quiz', () => {
    const sourceTemplate = {
      templateId: 'template-1',
      title: { en: 'Pride', pt: 'Orgulho' },
      copiedAt: '2026-11-01T10:00:00.000Z',
      lastPublishedAt: '2026-11-02T10:00:00.000Z',
      hasUpdate: true,
      changeNote: emptyText,
    };
    const quiz = toQuizshowQuiz(storedQuizRecord, [], [], sourceTemplate);
    expect(quiz.sourceTemplate).toEqual(sourceTemplate);
  });

  it('stores wheel and party rows without warm-up or talk time and their questions with an instant reveal', () => {
    const { rounds, questions } = buildRoundRows('quiz-1', [
      inputRound('wheel', { isWarmUp: true, talkSeconds: 20 }),
      inputRound(
        'drag_name',
        { isWarmUp: true, talkSeconds: 20 },
        {
          questions: [
            questionOf({
              type: 'prompt',
              options: [],
              answer: null,
              mediaReveal: 'slow',
            }),
          ],
        },
      ),
      inputRound('quiz'),
      inputRound('quiz'),
    ]);
    expect(rounds[0]?.settings).toMatchObject({
      isWarmUp: false,
      talkSeconds: 0,
    });
    expect(rounds[1]?.settings).toMatchObject({
      isWarmUp: false,
      talkSeconds: 0,
    });
    const partyQuestion = questions.find(
      (row) => row.roundId === rounds[1]?.id,
    );
    expect(partyQuestion?.mediaReveal).toBe('instant');
  });

  it('keeps a slow reveal and the talk time on a quiz row', () => {
    const { rounds, questions } = buildRoundRows('quiz-1', [
      inputRound(
        'quiz',
        { talkSeconds: 20 },
        {
          questions: [
            questionOf({ mediaRef: 'event-cover/abc', mediaReveal: 'slow' }),
          ],
        },
      ),
    ]);
    expect(rounds[0]?.settings).toMatchObject({ talkSeconds: 20 });
    expect(questions[0]?.mediaReveal).toBe('slow');
  });

  it('turns the joker off on a warm-up row', () => {
    const { rounds } = buildRoundRows('quiz-1', [
      inputRound('quiz', { isWarmUp: true, isJokerAllowed: true }),
      inputRound('quiz', { isJokerAllowed: true }),
    ]);
    expect(rounds[0]?.settings).toMatchObject({
      isWarmUp: true,
      isJokerAllowed: false,
    });
    expect(rounds[1]?.settings).toMatchObject({
      isWarmUp: false,
      isJokerAllowed: true,
    });
  });

  it('stores a unit only on closest number questions', () => {
    const years = { en: 'years', pt: 'anos' };
    const { questions } = buildRoundRows('quiz-1', [
      inputRound(
        'quiz',
        {},
        {
          questions: [
            questionOf({ numberUnit: years }),
            questionOf({
              type: 'closest_number',
              options: [],
              answer: { value: 1969, tolerance: { mode: 'exact', amount: 0 } },
              numberUnit: years,
            }),
          ],
        },
      ),
    ]);
    expect([questions[0]?.numberUnitEn, questions[0]?.numberUnitPt]).toEqual([
      '',
      '',
    ]);
    expect([questions[1]?.numberUnitEn, questions[1]?.numberUnitPt]).toEqual([
      'years',
      'anos',
    ]);
  });

  it('stores no reveal note on a prompt question', () => {
    const note = { en: 'Fun fact', pt: 'Curiosidade' };
    const { questions } = buildRoundRows('quiz-1', [
      inputRound('quiz', {}, { questions: [questionOf({ revealNote: note })] }),
      inputRound(
        'lie_detector',
        {},
        {
          questions: [
            questionOf({
              type: 'prompt',
              options: [],
              answer: null,
              revealNote: note,
            }),
          ],
        },
      ),
    ]);
    expect([questions[0]?.revealNoteEn, questions[0]?.revealNotePt]).toEqual([
      'Fun fact',
      'Curiosidade',
    ]);
    expect([questions[1]?.revealNoteEn, questions[1]?.revealNotePt]).toEqual([
      '',
      '',
    ]);
  });

  it('fills the v2 question fields an older studio page leaves out', () => {
    const olderQuestion = {
      type: 'true_false',
      prompt: { en: 'Prompt', pt: 'Pergunta' },
      mediaRef: null,
      timeLimitSeconds: null,
      points: 1000,
      options: [],
      answer: { isTrue: true },
      acceptedAnswers: [],
    } as unknown as QuizshowQuestionInput;
    const { questions } = buildRoundRows('quiz-1', [
      inputRound('quiz', {}, { questions: [olderQuestion] }),
    ]);
    expect(questions[0]).toMatchObject({
      mediaAltEn: '',
      mediaAltPt: '',
      mediaReveal: 'instant',
      revealNoteEn: '',
      revealNotePt: '',
      numberUnitEn: '',
      numberUnitPt: '',
    });
  });

  it('moves a Both screen onto the one language of a single language quiz', () => {
    expect(normalisedScreenLanguage('en', 'both')).toBe('en');
    expect(normalisedScreenLanguage('pt', 'both')).toBe('pt');
    expect(normalisedScreenLanguage('both', 'both')).toBe('both');
    expect(normalisedScreenLanguage('both', 'pt')).toBe('pt');
    expect(normalisedScreenLanguage('en', 'en')).toBe('en');
  });
});
