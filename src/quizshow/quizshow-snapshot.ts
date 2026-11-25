import * as crypto from 'crypto';
import {
  QUIZSHOW_JOIN_CODE_ALPHABET,
  QUIZSHOW_LIMITS,
  type QuizshowAnswerKeyView,
  type QuizshowHostQuestionView,
  type QuizshowLanguage,
  type QuizshowLanguageMode,
  type QuizshowOption,
  type QuizshowPlayMode,
  type QuizshowQuestion,
  type QuizshowQuestionView,
  type QuizshowQuiz,
  type QuizshowRound,
  type QuizshowRoundCard,
  type QuizshowScreenLanguage,
} from './quizshow.contract';
import {
  normaliseStoredQuestion,
  withRoundSettingsDefaults,
} from './quizshow-stored-shapes';
import { isQuizRoundKind, isWheelRoundKind } from './quizshow-wheel';

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
  screenLanguage: QuizshowScreenLanguage;
  rounds: QuizshowSnapshotRound[];
  /** The quiz `updatedAt` this snapshot was built from; '' on a snapshot stored before v2. */
  sourceUpdatedAt: string;
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
  // MC and poll keep the authored order: the option index is the payload.
  if (question.type === 'multiple_choice' || question.type === 'poll') {
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
    sourceUpdatedAt: frozen.updatedAt,
  };
}

type StoredRecord = Readonly<Record<string, unknown>>;

function storedRecordOf(value: unknown): StoredRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as StoredRecord)
    : {};
}

function storedArrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function normaliseStoredRound(raw: unknown): QuizshowSnapshotRound {
  const stored = storedRecordOf(raw);
  return {
    ...(stored as Partial<QuizshowSnapshotRound>),
    settings: withRoundSettingsDefaults(storedRecordOf(stored.settings)),
    questions: storedArrayOf(stored.questions).map((question) =>
      normaliseStoredQuestion<QuizshowSnapshotQuestion>(
        storedRecordOf(question),
      ),
    ),
  } as QuizshowSnapshotRound;
}

/**
 * Reads `quiz_snapshot` as stored (contract 8.2). A snapshot frozen before v2
 * keeps playing as it was authored: every question goes through the stored
 * shape normaliser (its `shownOptions` stay as frozen), every round gets the
 * settings defaults and a missing `sourceUpdatedAt` reads ''. Idempotent.
 */
export function normaliseStoredSnapshot(raw: unknown): QuizshowSessionSnapshot {
  const stored = storedRecordOf(raw);
  return {
    ...(stored as Partial<QuizshowSessionSnapshot>),
    rounds: storedArrayOf(stored.rounds).map((round) =>
      normaliseStoredRound(round),
    ),
    sourceUpdatedAt:
      typeof stored.sourceUpdatedAt === 'string' ? stored.sourceUpdatedAt : '',
  } as QuizshowSessionSnapshot;
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

/** Contract 6.12: the `read` length scales with the longest shown language, prompt plus options. */
export function readPhaseMsFor(
  question: QuizshowSnapshotQuestion,
  languages: QuizshowLanguageMode,
): number {
  const shown: QuizshowLanguage[] =
    languages === 'both' ? ['en', 'pt'] : [languages];
  const characters = Math.max(
    ...shown.map(
      (language) =>
        question.prompt[language].length +
        (question.shownOptions ?? question.options).reduce(
          (sum, option) => sum + option.text[language].length,
          0,
        ),
    ),
  );
  return Math.min(
    Math.max(
      QUIZSHOW_LIMITS.readPhaseBaseMs +
        QUIZSHOW_LIMITS.readPhaseMsPerChar * characters,
      QUIZSHOW_LIMITS.readPhaseMinMs,
    ),
    QUIZSHOW_LIMITS.readPhaseMaxMs,
  );
}

export function toRoundCard(
  round: QuizshowSnapshotRound,
  roundIndex: number,
  playMode: QuizshowPlayMode,
): QuizshowRoundCard {
  if (isWheelRoundKind(round.kind)) {
    // A wheel is a plain card: no questions, no joker, nothing to label.
    return {
      roundIndex,
      kind: 'wheel',
      title: round.title,
      contentLabel: 'none',
      questionCount: 0,
      isJokerAllowed: false,
      isSpeedBonusOn: round.settings.isSpeedBonusOn,
      isWarmUp: false,
      talkSeconds: 0,
    };
  }
  return {
    roundIndex,
    kind: round.kind,
    title: round.title,
    contentLabel: round.contentLabel,
    questionCount: round.questions.length,
    isJokerAllowed: round.settings.isJokerAllowed,
    isSpeedBonusOn: round.settings.isSpeedBonusOn,
    isWarmUp: round.settings.isWarmUp,
    // Solo play has no team to talk with (contract 6.20).
    talkSeconds: playMode === 'solo' ? 0 : round.settings.talkSeconds,
  };
}

/** Screen and players: built field by field so no answer key can ride along. */
export function toQuestionView(
  round: QuizshowSnapshotRound,
  question: QuizshowSnapshotQuestion,
  roundIndex: number,
  questionIndex: number,
  languages: QuizshowLanguageMode,
): QuizshowQuestionView {
  const isQuizRound = isQuizRoundKind(round.kind);
  const timeLimitSeconds = isQuizRound
    ? (question.timeLimitSeconds ?? round.settings.timeLimitSeconds)
    : round.settings.writeSeconds;
  return {
    questionId: question.id,
    roundIndex,
    questionIndex,
    roundKind: round.kind,
    type: question.type,
    prompt: question.prompt,
    mediaUrl: question.mediaUrl,
    mediaAlt: question.mediaAlt,
    mediaReveal: question.mediaReveal,
    numberUnit: question.numberUnit,
    points: question.points,
    timeLimitSeconds,
    // Party rounds open on `write`, with no read phase before it.
    readMs: isQuizRound ? readPhaseMsFor(question, languages) : 0,
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
            correctIndexes: question.answer.correctIndexes,
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
        : {
            type: 'closest_number',
            value: question.answer.value,
            tolerance: question.answer.tolerance,
          };
    case 'prompt':
      return round.kind === 'lie_detector' && question.answer !== null
        ? { type: 'lie_detector', truth: question.answer.truth }
        : null;
    case 'poll':
      // A poll has no right answer, so there is no key to show.
      return null;
  }
}

/** The key the night judges by: a host correction when one was made, else the authored key. */
export function effectiveAnswerKey(
  round: Pick<QuizshowSnapshotRound, 'kind'>,
  question: QuizshowSnapshotQuestion,
  keyOverride: QuizshowAnswerKeyView | null,
): QuizshowAnswerKeyView | null {
  return keyOverride ?? toAnswerKeyView(round, question);
}

export function toHostQuestionView(
  round: QuizshowSnapshotRound,
  question: QuizshowSnapshotQuestion,
  roundIndex: number,
  questionIndex: number,
  languages: QuizshowLanguageMode,
  keyOverride: QuizshowAnswerKeyView | null,
): QuizshowHostQuestionView {
  return {
    ...toQuestionView(round, question, roundIndex, questionIndex, languages),
    answerKey: effectiveAnswerKey(round, question, keyOverride),
    // Hosts see the fun fact from `read` on; the public view never carries it.
    revealNote: question.revealNote,
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
