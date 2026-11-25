import { randomUUID } from 'crypto';
import { toImageUrl } from '../common/image-url';
import type { QuizshowQuestionRecord } from './entities/quizshow-question.entity';
import type { QuizshowQuizRecord } from './entities/quizshow-quiz.entity';
import type { QuizshowRoundRecord } from './entities/quizshow-round.entity';
import {
  isPartyRoundKind,
  type QuizshowValidatableQuiz,
} from './quizshow-quiz-validation';
import {
  normaliseStoredQuestion,
  withRoundSettingsDefaults,
} from './quizshow-stored-shapes';
import {
  isQuizRoundKind,
  isWheelRoundKind,
  normaliseWheelRounds,
} from './quizshow-wheel';
import type {
  QuizshowLanguageMode,
  QuizshowQuestion,
  QuizshowQuestionInput,
  QuizshowQuiz,
  QuizshowQuizShape,
  QuizshowRound,
  QuizshowRoundKind,
  QuizshowRoundSettings,
  QuizshowScreenLanguage,
  QuizshowSourceTemplateRef,
  QuizshowText,
} from './quizshow.contract';

// Contract 2.4 names this module as the reader of stored questions, so every
// caller that maps rows can reach the one normaliser from here.
export { normaliseStoredQuestion } from './quizshow-stored-shapes';

const EMPTY_TEXT: Readonly<QuizshowText> = { en: '', pt: '' };

function toQuizshowQuestion(record: QuizshowQuestionRecord): QuizshowQuestion {
  // Contract 2.4 sends every stored question through one idempotent normaliser,
  // so a row the v2 migration has not reached yet reads like a fresh one.
  return normaliseStoredQuestion<QuizshowQuestion>({
    id: record.id,
    type: record.type,
    prompt: { en: record.promptEn, pt: record.promptPt },
    mediaRef: record.mediaRef,
    mediaUrl: toImageUrl(record.mediaRef),
    mediaAlt: { en: record.mediaAltEn, pt: record.mediaAltPt },
    mediaReveal: record.mediaReveal,
    revealNote: { en: record.revealNoteEn, pt: record.revealNotePt },
    numberUnit: { en: record.numberUnitEn, pt: record.numberUnitPt },
    timeLimitSeconds: record.timeLimitSeconds,
    points: record.points,
    options: record.options,
    answer: record.answer,
    acceptedAnswers: record.acceptedAnswers,
  });
}

/**
 * `'both'` needs a quiz written in both languages (contract 6.26). Every other
 * pair is valid today and keeps its stored value.
 */
export function normalisedScreenLanguage(
  languages: QuizshowLanguageMode,
  screenLanguage: QuizshowScreenLanguage,
): QuizshowScreenLanguage {
  return screenLanguage === 'both' && languages !== 'both'
    ? languages
    : screenLanguage;
}

/** Rows to the wire quiz: rounds and questions in position order. The caller resolves `sourceTemplate`. */
export function toQuizshowQuiz(
  quiz: QuizshowQuizRecord,
  rounds: QuizshowRoundRecord[],
  questions: QuizshowQuestionRecord[],
  sourceTemplate: QuizshowSourceTemplateRef | null = null,
): QuizshowQuiz {
  const orderedQuestions = [...questions].sort(
    (first, second) => first.position - second.position,
  );
  const mappedRounds: QuizshowRound[] = [...rounds]
    .sort((first, second) => first.position - second.position)
    .map((round) => ({
      id: round.id,
      kind: round.kind,
      title: { en: round.titleEn, pt: round.titlePt },
      contentLabel: round.contentLabel,
      settings: withRoundSettingsDefaults(round.settings),
      questions: orderedQuestions
        .filter((question) => question.roundId === round.id)
        .map(toQuizshowQuestion),
    }));
  return {
    title: quiz.title,
    languages: quiz.languages,
    screenLanguage: quiz.screenLanguage,
    sourceTemplateId: quiz.sourceTemplateId,
    sourceTemplate,
    updatedAt: quiz.updatedAt.toISOString(),
    rounds: mappedRounds,
  };
}

/** The wire quiz without ids, urls and the stamp: the shape an input or an import copies. */
export function toQuizShape(quiz: QuizshowQuiz): QuizshowQuizShape {
  return {
    title: quiz.title,
    languages: quiz.languages,
    screenLanguage: quiz.screenLanguage,
    rounds: quiz.rounds.map((round) => ({
      kind: round.kind,
      title: round.title,
      contentLabel: round.contentLabel,
      settings: round.settings,
      questions: round.questions.map(
        ({ id: _id, mediaUrl: _mediaUrl, ...questionInput }) => questionInput,
      ),
    })),
  };
}

/** Contract 2.4 and 6.19: the settings a row of this kind keeps on save. */
function savedRoundSettings(
  kind: QuizshowRoundKind,
  settings: Partial<QuizshowRoundSettings>,
): QuizshowRoundSettings {
  // An older studio page saves without the v2 settings, so they get their defaults here.
  const defaultedSettings = withRoundSettingsDefaults(settings);
  if (isWheelRoundKind(kind) || isPartyRoundKind(kind)) {
    return { ...defaultedSettings, isWarmUp: false, talkSeconds: 0 };
  }
  // A warm-up round scores nothing, so a joker played on it would be spent for no gain.
  return defaultedSettings.isWarmUp
    ? { ...defaultedSettings, isJokerAllowed: false }
    : defaultedSettings;
}

/** Contract 2.4: the question fields a save keeps, with the v2 defaults filled in. */
function savedQuestion(
  question: QuizshowQuestionInput,
  isQuizRow: boolean,
): QuizshowQuestionInput {
  const normalisedQuestion = normaliseStoredQuestion(
    question as unknown as Readonly<Record<string, unknown>>,
  );
  return {
    ...normalisedQuestion,
    // Only quiz rounds blur a picture in (contract 6.23).
    mediaReveal: isQuizRow ? normalisedQuestion.mediaReveal : 'instant',
    numberUnit:
      normalisedQuestion.type === 'closest_number'
        ? normalisedQuestion.numberUnit
        : { ...EMPTY_TEXT },
    revealNote:
      normalisedQuestion.type === 'prompt'
        ? { ...EMPTY_TEXT }
        : normalisedQuestion.revealNote,
  };
}

/** New rows with fresh uuids, so each question names its round before insert. */
export function buildRoundRows(
  quizId: string,
  rounds: QuizshowValidatableQuiz['rounds'],
): {
  rounds: Partial<QuizshowRoundRecord>[];
  questions: Partial<QuizshowQuestionRecord>[];
} {
  const roundRows: Partial<QuizshowRoundRecord>[] = [];
  const questionRows: Partial<QuizshowQuestionRecord>[] = [];
  const normalisedRounds = normaliseWheelRounds(rounds);
  normalisedRounds.forEach((round, roundPosition) => {
    const roundId = randomUUID();
    roundRows.push({
      id: roundId,
      quizId,
      position: roundPosition,
      kind: round.kind,
      titleEn: round.title.en,
      titlePt: round.title.pt,
      contentLabel: round.contentLabel,
      settings: savedRoundSettings(round.kind, round.settings),
    });
    const isQuizRow = isQuizRoundKind(round.kind);
    round.questions.forEach((inputQuestion, questionPosition) => {
      const question = savedQuestion(inputQuestion, isQuizRow);
      questionRows.push({
        id: randomUUID(),
        roundId,
        position: questionPosition,
        type: question.type,
        promptEn: question.prompt.en,
        promptPt: question.prompt.pt,
        mediaRef: question.mediaRef,
        mediaAltEn: question.mediaAlt.en,
        mediaAltPt: question.mediaAlt.pt,
        mediaReveal: question.mediaReveal,
        revealNoteEn: question.revealNote.en,
        revealNotePt: question.revealNote.pt,
        numberUnitEn: question.numberUnit.en,
        numberUnitPt: question.numberUnit.pt,
        options: question.options,
        answer: question.answer,
        acceptedAnswers: question.acceptedAnswers,
        timeLimitSeconds: question.timeLimitSeconds,
        points: question.points,
      });
    });
  });
  return { rounds: roundRows, questions: questionRows };
}
