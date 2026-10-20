import * as crypto from 'crypto';
import {
  QUIZSHOW_JOIN_CODE_ALPHABET,
  QUIZSHOW_LIMITS,
  type QuizshowAnswerKeyView,
  type QuizshowHostQuestionView,
  type QuizshowLanguage,
  type QuizshowLanguageMode,
  type QuizshowOption,
  type QuizshowQuestion,
  type QuizshowQuestionView,
  type QuizshowQuiz,
  type QuizshowRound,
  type QuizshowRoundCard,
} from './quizshow.contract';
import { isPartyRoundKind } from './quizshow-quiz-validation';

/** Injected randomness so engine and snapshot specs stay deterministic. */
export interface QuizshowRandom {
  uuid(): string;
  integerBelow(limit: number): number;
}

export const CRYPTO_RANDOM: QuizshowRandom = {
  uuid: () => crypto.randomUUID(),
  integerBelow: (limit: number) => crypto.randomInt(limit),
};

export type QuizshowSnapshotQuestion = QuizshowQuestion & {
  shownOptions: QuizshowOption[] | null;
};

export type QuizshowSnapshotRound = Omit<QuizshowRound, 'questions'> & {
  questions: QuizshowSnapshotQuestion[];
};

export interface QuizshowSessionSnapshot {
  title: string;
  languages: QuizshowLanguageMode;
  screenLanguage: QuizshowLanguage;
  rounds: QuizshowSnapshotRound[];
}

/**
 * Fisher-Yates over a copy, then a left rotation by one when the result
 * equals `correctOrder` element by element.
 */
export function shuffleAvoidingOrder<Item>(
  items: readonly Item[],
  correctOrder: readonly Item[],
  random: QuizshowRandom,
): Item[] {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = random.integerBelow(index + 1);
    // Both indexes are in range by construction (swapIndex <= index < length).
    const held = shuffled[index] as Item;
    shuffled[index] = shuffled[swapIndex] as Item;
    shuffled[swapIndex] = held;
  }
  const isCorrectOrder =
    shuffled.length === correctOrder.length &&
    shuffled.every((item, index) => item === correctOrder[index]);
  if (isCorrectOrder && shuffled.length > 1) {
    shuffled.push(shuffled.shift() as Item);
  }
  return shuffled;
}

function shownOptionsFor(
  question: QuizshowQuestion,
  random: QuizshowRandom,
): QuizshowOption[] | null {
  if (question.type === 'multiple_choice') {
    return question.options.map((option) => ({
      id: option.id,
      text: { ...option.text },
    }));
  }
  if (question.type === 'order') {
    const correctOrder: QuizshowOption[] = (question.answer?.orderedIds ?? [])
      .map((optionId) =>
        question.options.find((option) => option.id === optionId),
      )
      .filter((option): option is QuizshowOption => option !== undefined);
    return shuffleAvoidingOrder(question.options, correctOrder, random).map(
      (option) => ({ id: option.id, text: { ...option.text } }),
    );
  }
  return null;
}

export function buildSessionSnapshot(
  quiz: QuizshowQuiz,
  random: QuizshowRandom,
): QuizshowSessionSnapshot {
  const frozen = structuredClone(quiz);
  return {
    title: frozen.title,
    languages: frozen.languages,
    screenLanguage: frozen.screenLanguage,
    rounds: frozen.rounds.map((round) => ({
      ...round,
      questions: round.questions.map((question): QuizshowSnapshotQuestion => ({
        ...question,
        shownOptions: shownOptionsFor(question, random),
      })),
    })),
  };
}

export function snapshotQuestionAt(
  snapshot: QuizshowSessionSnapshot,
  roundIndex: number,
  questionIndex: number,
): QuizshowSnapshotQuestion | null {
  return snapshot.rounds[roundIndex]?.questions[questionIndex] ?? null;
}

export function questionCount(snapshot: QuizshowSessionSnapshot): number {
  return snapshot.rounds.reduce(
    (total, round) => total + round.questions.length,
    0,
  );
}

export function isLastQuestionOfRound(
  snapshot: QuizshowSessionSnapshot,
  roundIndex: number,
  questionIndex: number,
): boolean {
  const round = snapshot.rounds[roundIndex];
  return round !== undefined && questionIndex === round.questions.length - 1;
}

export function isLastRound(
  snapshot: QuizshowSessionSnapshot,
  roundIndex: number,
): boolean {
  return roundIndex === snapshot.rounds.length - 1;
}

export function openLimitMs(
  round: Pick<QuizshowSnapshotRound, 'settings'>,
  question: Pick<QuizshowQuestion, 'timeLimitSeconds'>,
): number {
  return (question.timeLimitSeconds ?? round.settings.timeLimitSeconds) * 1000;
}

export function writeLimitMs(
  round: Pick<QuizshowSnapshotRound, 'settings'>,
): number {
  return round.settings.writeSeconds * 1000;
}

export function voteLimitMs(
  round: Pick<QuizshowSnapshotRound, 'settings'>,
): number {
  return round.settings.voteSeconds * 1000;
}

export function extraTimeMs(limitMs: number): number {
  return Math.round(limitMs * QUIZSHOW_LIMITS.extraTimeFactor);
}

export function toRoundCard(
  round: QuizshowSnapshotRound,
  roundIndex: number,
): QuizshowRoundCard {
  return {
    roundIndex,
    kind: round.kind,
    title: round.title,
    contentLabel: round.contentLabel,
    questionCount: round.questions.length,
    isJokerAllowed: round.settings.isJokerAllowed,
    isSpeedBonusOn: round.settings.isSpeedBonusOn,
  };
}

/** Screen and players: built field by field so no answer key can ride along. */
export function toQuestionView(
  round: QuizshowSnapshotRound,
  question: QuizshowSnapshotQuestion,
  roundIndex: number,
  questionIndex: number,
): QuizshowQuestionView {
  const timeLimitSeconds = isPartyRoundKind(round.kind)
    ? round.settings.writeSeconds
    : (question.timeLimitSeconds ?? round.settings.timeLimitSeconds);
  return {
    questionId: question.id,
    roundIndex,
    questionIndex,
    roundKind: round.kind,
    type: question.type,
    prompt: question.prompt,
    mediaUrl: question.mediaUrl,
    points: question.points,
    timeLimitSeconds,
    options: question.shownOptions,
  };
}

export function toAnswerKeyView(
  round: Pick<QuizshowSnapshotRound, 'kind'>,
  question: QuizshowSnapshotQuestion,
): QuizshowAnswerKeyView | null {
  if (round.kind === 'caption_this' || round.kind === 'drag_name') {
    return null;
  }
  switch (question.type) {
    case 'multiple_choice':
      return question.answer === null
        ? null
        : {
            type: 'multiple_choice',
            correctIndex: question.answer.correctIndex,
          };
    case 'true_false':
      return question.answer === null
        ? null
        : { type: 'true_false', isTrue: question.answer.isTrue };
    case 'type_answer':
      return question.answer === null
        ? null
        : {
            type: 'type_answer',
            text: question.answer.text,
            acceptedAnswers: question.acceptedAnswers,
          };
    case 'order':
      return question.answer === null
        ? null
        : { type: 'order', orderedIds: question.answer.orderedIds };
    case 'closest_number':
      return question.answer === null
        ? null
        : { type: 'closest_number', value: question.answer.value };
    case 'prompt':
      return round.kind === 'lie_detector' && question.answer !== null
        ? { type: 'lie_detector', truth: question.answer.truth }
        : null;
  }
}

export function toHostQuestionView(
  round: QuizshowSnapshotRound,
  question: QuizshowSnapshotQuestion,
  roundIndex: number,
  questionIndex: number,
): QuizshowHostQuestionView {
  return {
    ...toQuestionView(round, question, roundIndex, questionIndex),
    answerKey: toAnswerKeyView(round, question),
  };
}

export function generateJoinCode(random: QuizshowRandom): string {
  let code = '';
  for (let draw = 0; draw < 6; draw += 1) {
    code +=
      QUIZSHOW_JOIN_CODE_ALPHABET[
        random.integerBelow(QUIZSHOW_JOIN_CODE_ALPHABET.length)
      ];
  }
  return code;
}
