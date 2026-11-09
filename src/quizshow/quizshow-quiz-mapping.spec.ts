import type { QuizshowQuizRecord } from './entities/quizshow-quiz.entity';
import type { QuizshowRoundRecord } from './entities/quizshow-round.entity';
import {
  buildRoundRows,
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

const filledQuestion: QuizshowQuestionInput = {
  type: 'true_false',
  prompt: { en: 'Prompt', pt: 'Pergunta' },
  mediaRef: null,
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
});
