import {
  QUIZSHOW_LIMITS,
  type QuizshowClosestTolerance,
  type QuizshowQuestionInput,
  type QuizshowRecap,
  type QuizshowRecapQuestion,
  type QuizshowRoundSettings,
  type QuizshowText,
} from './quizshow.contract';
import { withWheelSettingsDefaults } from './quizshow-wheel';

/**
 * Read-side normalisers for quiz JSON stored before Pulse Live v2 (contract
 * 2.4, 6.24 and 8.2). The migration rewrites question and round rows, but
 * stored session snapshots, results and templates keep their old shape, so
 * every reader runs them through here. Each function returns a new object,
 * leaves its input untouched and is idempotent. The module imports only the
 * contract file and the wheel helpers, so every layer can use it without a
 * dependency cycle. The frontend mirrors it by hand.
 */

type StoredRecord = Readonly<Record<string, unknown>>;

function isStoredRecord(value: unknown): value is StoredRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emptyText(): QuizshowText {
  return { en: '', pt: '' };
}

const YEAR_FIRST = 1000;
const YEAR_LAST = 2100;
const YEAR_WIDE_MARGIN_BEFORE = 1990;

/**
 * The band a closest-number answer without a tolerance gets: a whole year from
 * 1000 to 2100 gets an absolute margin (10 before 1990, 5 from 1990), the rule
 * the v2 migration applies; every other value keeps the legacy percent band.
 */
function legacyClosestTolerance(value: unknown): QuizshowClosestTolerance {
  const isYear =
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= YEAR_FIRST &&
    value <= YEAR_LAST;
  if (isYear) {
    return {
      mode: 'absolute',
      amount: value < YEAR_WIDE_MARGIN_BEFORE ? 10 : 5,
    };
  }
  return { mode: 'percent', amount: QUIZSHOW_LIMITS.closestLegacyPercent };
}

function normaliseStoredAnswer(type: unknown, answer: unknown): unknown {
  if (!isStoredRecord(answer)) {
    // A null answer (an unfinished question) stays null.
    return answer;
  }
  if (
    type === 'multiple_choice' &&
    answer.correctIndexes === undefined &&
    typeof answer.correctIndex === 'number'
  ) {
    return { correctIndexes: [answer.correctIndex] };
  }
  if (type === 'closest_number' && answer.tolerance === undefined) {
    return { ...answer, tolerance: legacyClosestTolerance(answer.value) };
  }
  return answer;
}

/**
 * Contract 2.4 read table: MC `correctIndex` becomes `correctIndexes`, a
 * closest answer without a tolerance reads "Within 10%", and the four
 * question fields added in v2 get their defaults. Every other key, `id`,
 * `mediaUrl` and `shownOptions` included, is copied as stored.
 */
export function normaliseStoredQuestion<
  Question extends QuizshowQuestionInput = QuizshowQuestionInput,
>(raw: Readonly<Record<string, unknown>>): Question {
  const question: Record<string, unknown> = {
    ...raw,
    answer: normaliseStoredAnswer(raw.type, raw.answer),
    mediaAlt: raw.mediaAlt ?? emptyText(),
    mediaReveal: raw.mediaReveal ?? 'instant',
    revealNote: raw.revealNote ?? emptyText(),
    numberUnit: raw.numberUnit ?? emptyText(),
  };
  if (!('answer' in raw)) {
    // Keep an absent key absent so the copy stays equal to its input.
    delete question.answer;
  }
  return question as Question;
}

/** The three wheel defaults plus the two v2 settings: warm-up off and zero talk seconds. */
export function withRoundSettingsDefaults(
  settings: Partial<QuizshowRoundSettings>,
): QuizshowRoundSettings {
  const wheelDefaulted = withWheelSettingsDefaults(settings);
  return {
    ...wheelDefaulted,
    isWarmUp: settings.isWarmUp ?? false,
    talkSeconds: settings.talkSeconds ?? 0,
  } as QuizshowRoundSettings;
}

function normaliseStoredRecapQuestion(raw: unknown): QuizshowRecapQuestion {
  const stored = isStoredRecord(raw) ? raw : {};
  return {
    ...(stored as Partial<QuizshowRecapQuestion>),
    isWarmUp: stored.isWarmUp === true,
    wasCorrected: stored.wasCorrected === true,
  } as QuizshowRecapQuestion;
}

/** Contract 6.24: a recap stored before v2 reads with no standings and no warm-up or corrected question. */
export function normaliseStoredRecap(raw: unknown): QuizshowRecap {
  const stored = isStoredRecord(raw) ? raw : {};
  const questions: unknown[] = Array.isArray(stored.questions)
    ? stored.questions
    : [];
  return {
    ...(stored as Partial<QuizshowRecap>),
    questionsPlayed:
      typeof stored.questionsPlayed === 'number' ? stored.questionsPlayed : 0,
    answersGiven:
      typeof stored.answersGiven === 'number' ? stored.answersGiven : 0,
    questions: questions.map((question) =>
      normaliseStoredRecapQuestion(question),
    ),
    standings: Array.isArray(stored.standings)
      ? (stored.standings as QuizshowRecap['standings'])
      : [],
  };
}
