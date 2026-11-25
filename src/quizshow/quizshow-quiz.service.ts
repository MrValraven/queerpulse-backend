import { HttpException, Injectable } from '@nestjs/common';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { assertNoForeignUploadIntroduced } from '../storage/assert-no-foreign-upload';
import type { Event } from '../events/entities/event.entity';
import { QuizshowQuestionRecord } from './entities/quizshow-question.entity';
import { QuizshowQuizRecord } from './entities/quizshow-quiz.entity';
import { QuizshowRoundRecord } from './entities/quizshow-round.entity';
import { QuizshowAccessService } from './quizshow-access.service';
import { QuizshowImportDto } from './dto/quizshow-import.dto';
import { QuizshowQuizInputDto } from './dto/quizshow-quiz-input.dto';
import {
  quizshowCodeOf,
  quizshowError,
  quizshowErrorWithDetails,
} from './quizshow-errors';
import {
  listOrganisedEventSources,
  listOwnedGameSources,
} from './quizshow-import-sources';
import {
  buildRoundRows,
  normaliseStoredQuestion,
  normalisedScreenLanguage,
  toQuizShape,
  toQuizshowQuiz,
} from './quizshow-quiz-mapping';
import {
  completenessProblems,
  hasAdultsRound,
  structuralProblems,
  type QuizshowValidatableQuiz,
} from './quizshow-quiz-validation';
import { withRoundSettingsDefaults } from './quizshow-stored-shapes';
import { nameOf } from './quizshow-template-reads';
import {
  isWheelRoundKind,
  wheelRoundIndexOfRange,
  wheelSliceRoundIndexes,
} from './quizshow-wheel';
import { QUIZSHOW_LIMITS } from './quizshow.contract';
import type {
  QuizshowErrorCode,
  QuizshowGameResponse,
  QuizshowImportSource,
  QuizshowLiveSessionRef,
  QuizshowQuestionInput,
  QuizshowQuiz,
  QuizshowQuizChangedDetails,
  QuizshowQuizProblemCode,
  QuizshowQuizResponse,
  QuizshowQuizShape,
  QuizshowRoundInput,
  QuizshowSourceTemplateRef,
} from './quizshow.contract';

const QUIZ_EVENT_UNIQUE_CONSTRAINT = 'UQ_quizshow_quizzes_event_id';

/** Where a quiz write lands: an event's quiz, a stored game, a game created now, or a staff template's quiz. */
export type QuizshowQuizTarget =
  | { kind: 'event'; event: Event }
  | { kind: 'game'; gameId: string; isAdultsOnly: boolean }
  | { kind: 'new_game'; ownerUserId: string; isAdultsOnly: boolean }
  | { kind: 'template'; templateId: string };

export interface QuizshowQuizWriteInput {
  target: QuizshowQuizTarget;
  userId: string;
  shape: QuizshowQuizShape;
  sourceTemplateId: string | null;
  /** When the quiz copied its source template (contract 6.25); undefined keeps the stored value. */
  sourceTemplateCopiedAt?: Date | null;
  /** undefined skips the stale check (replace imports and new games). */
  expectedUpdatedAt: string | null | undefined;
}

export interface QuizshowImportedShape {
  shape: QuizshowQuizShape;
  sourceTemplateId: string | null;
  /** Now for a template source; the source quiz's own stamp for an event or a game. */
  sourceTemplateCopiedAt: Date | null;
}

/** An import into an event's quiz or a stored game (contract 6.28). */
export interface QuizshowImportRun {
  target: Extract<QuizshowQuizTarget, { kind: 'event' } | { kind: 'game' }>;
  userId: string;
  input: QuizshowImportDto;
  exclusion: { eventSlug: string | null; gameId: string | null };
  /** A game keeps its own title on every import; null takes the source's on replace. */
  keptTitle: string | null;
}

/** A stored quiz row with its wire quiz. */
interface LoadedQuiz {
  record: QuizshowQuizRecord;
  quiz: QuizshowQuiz;
}

/** Which import limit each structural problem code stands for (contract 6.28), checked in this order. */
const IMPORT_LIMIT_CODES: ReadonlyArray<
  [QuizshowQuizProblemCode, QuizshowErrorCode]
> = [
  ['too_many_rounds', 'quizshow_import_too_many_rounds'],
  ['too_many_questions', 'quizshow_import_too_many_questions'],
  ['too_many_wheels', 'quizshow_import_too_many_wheels'],
];

/** $1 quiz id: the quiz's source template while it is published, with its card title and latest publish. */
const SOURCE_TEMPLATE_SQL = `
  SELECT
    "template"."id" AS "template_id",
    "template"."card_title_en" AS "card_title_en",
    "template"."card_title_pt" AS "card_title_pt",
    "template"."content_updated_at" AS "content_updated_at",
    "template"."change_note_en" AS "change_note_en",
    "template"."change_note_pt" AS "change_note_pt"
  FROM "quizshow_quizzes" "quiz"
  INNER JOIN "quizshow_templates" "template" ON "template"."id" = "quiz"."source_template_id"
  WHERE "quiz"."id" = $1
    AND "template"."published_at" IS NOT NULL
`;

/** $1 user id: the profile name of the member who last saved a quiz. */
const QUIZ_EDITOR_NAME_SQL = `
  SELECT "editor"."first_name" AS "first_name", "editor"."last_name" AS "last_name"
  FROM "profiles" "editor"
  WHERE "editor"."user_id" = $1
`;

interface SourceTemplateRow {
  template_id: string;
  card_title_en: string;
  card_title_pt: string;
  content_updated_at: Date | string | null;
  change_note_en: string;
  change_note_pt: string;
}

/** $1 template id: the template's quiz id while the template is published. */
const PUBLISHED_TEMPLATE_QUIZ_SQL = `
  SELECT "quiz"."id" AS "quiz_id" FROM "quizshow_templates" "template"
  INNER JOIN "quizshow_quizzes" "quiz" ON "quiz"."template_id" = "template"."id"
  WHERE "template"."id" = $1 AND "template"."published_at" IS NOT NULL
`;

/** $1 game quiz id: the open session with its player count, practice flag and snapshot stamp, and whether kept results exist. */
const GAME_RESPONSE_STATE_SQL = `
  SELECT
    "open_session"."id" AS "session_id",
    "open_session"."join_code" AS "join_code",
    "open_session"."status" AS "status",
    "open_session"."play_mode" AS "play_mode",
    "open_session"."started_at" AS "started_at",
    "open_session"."player_count" AS "player_count",
    "open_session"."is_practice" AS "is_practice",
    "open_session"."source_updated_at" AS "source_updated_at",
    EXISTS (
      SELECT 1
      FROM "quizshow_results" "result"
      INNER JOIN "quizshow_sessions" "kept_session" ON "kept_session"."id" = "result"."session_id"
      WHERE "kept_session"."quiz_id" = $1
        AND "kept_session"."results_kept" = true
    ) AS "has_results"
  FROM (SELECT 1) AS "anchor"
  LEFT JOIN LATERAL (
    SELECT
      "session"."id",
      "session"."join_code",
      "session"."status",
      "session"."play_mode",
      "session"."started_at",
      "session"."is_practice",
      ("session"."quiz_snapshot" ->> 'sourceUpdatedAt') AS "source_updated_at",
      (
        SELECT COUNT(*)::int FROM "quizshow_players" "player"
        WHERE "player"."session_id" = "session"."id"
          AND "player"."removed_at" IS NULL
      ) AS "player_count"
    FROM "quizshow_sessions" "session"
    WHERE "session"."quiz_id" = $1
      AND "session"."status" IN ('lobby', 'running', 'paused')
    LIMIT 1
  ) AS "open_session" ON true
`;

/** $1 event id: the open session with its player count, practice flag and snapshot stamp, and whether kept results exist. */
const QUIZ_RESPONSE_STATE_SQL = `
  SELECT
    "open_session"."id" AS "session_id",
    "open_session"."join_code" AS "join_code",
    "open_session"."status" AS "status",
    "open_session"."play_mode" AS "play_mode",
    "open_session"."started_at" AS "started_at",
    "open_session"."player_count" AS "player_count",
    "open_session"."is_practice" AS "is_practice",
    "open_session"."source_updated_at" AS "source_updated_at",
    EXISTS (
      SELECT 1
      FROM "quizshow_results" "result"
      INNER JOIN "quizshow_sessions" "kept_session" ON "kept_session"."id" = "result"."session_id"
      WHERE "kept_session"."event_id" = $1
        AND "kept_session"."results_kept" = true
    ) AS "has_results"
  FROM (SELECT 1) AS "anchor"
  LEFT JOIN LATERAL (
    SELECT
      "session"."id",
      "session"."join_code",
      "session"."status",
      "session"."play_mode",
      "session"."started_at",
      "session"."is_practice",
      ("session"."quiz_snapshot" ->> 'sourceUpdatedAt') AS "source_updated_at",
      (
        SELECT COUNT(*)::int FROM "quizshow_players" "player"
        WHERE "player"."session_id" = "session"."id"
          AND "player"."removed_at" IS NULL
      ) AS "player_count"
    FROM "quizshow_sessions" "session"
    WHERE "session"."event_id" = $1
      AND "session"."status" IN ('lobby', 'running', 'paused')
    LIMIT 1
  ) AS "open_session" ON true
`;

/** $1 source slug, $2 caller id: the event's id when the caller hosts or co-hosts it. */
const ORGANISED_EVENT_BY_SLUG_SQL = `
  SELECT "event"."id" AS "event_id"
  FROM "events" "event"
  WHERE "event"."slug" = $1
    AND (
      "event"."host_id" = $2
      OR EXISTS (
        SELECT 1 FROM "event_cohosts" "cohost"
        WHERE "cohost"."event_id" = "event"."id" AND "cohost"."user_id" = $2
      )
    )
`;

/** The open session columns a quiz response or a game list row reads. */
export interface QuizshowLiveSessionRow {
  session_id: string | null;
  join_code: string | null;
  status: QuizshowLiveSessionRef['status'] | null;
  play_mode: QuizshowLiveSessionRef['playMode'] | null;
  started_at: Date | string | null;
  player_count: number | null;
  is_practice: boolean | null;
  /** The quiz `updatedAt` the session snapshot was built from; null on a snapshot stored before v2. */
  source_updated_at: string | null;
}

interface QuizResponseStateRow extends QuizshowLiveSessionRow {
  has_results: boolean;
}

function isEventUniqueViolation(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const driverError = error.driverError as
    { code?: string; constraint?: string } | undefined;
  return (
    driverError?.code === '23505' &&
    driverError.constraint === QUIZ_EVENT_UNIQUE_CONSTRAINT
  );
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * The open session of a quiz. `quizUpdatedAt` is the stored quiz's stamp:
 * a lobby whose snapshot came from another save is behind (contract 6.10).
 * A snapshot stored before v2 has no stamp and reads as '', so an old lobby
 * reads as behind, which it is. A running session is never behind.
 */
export function toLiveSessionRef(
  state: QuizshowLiveSessionRow | undefined,
  quizUpdatedAt: string | null,
): QuizshowLiveSessionRef | null {
  if (
    !state?.session_id ||
    !state.join_code ||
    !state.status ||
    !state.play_mode ||
    !state.started_at
  ) {
    return null;
  }
  return {
    sessionId: state.session_id,
    joinCode: state.join_code,
    status: state.status,
    playMode: state.play_mode,
    playerCount: state.player_count ?? 0,
    startedAt: toIsoString(state.started_at),
    isPractice: state.is_practice === true,
    isBehindQuiz:
      state.status === 'lobby' &&
      quizUpdatedAt !== null &&
      (state.source_updated_at ?? '') !== quizUpdatedAt,
  };
}

/** Contract 2.4: MC `correctIndexes` are stored sorted ascending. */
function withSortedCorrectIndexes(
  question: QuizshowQuestionInput,
): QuizshowQuestionInput {
  if (
    question.type !== 'multiple_choice' ||
    question.answer === null ||
    !Array.isArray(question.answer.correctIndexes)
  ) {
    return question;
  }
  return {
    ...question,
    answer: {
      ...question.answer,
      correctIndexes: [...question.answer.correctIndexes].sort(
        (first, second) => first - second,
      ),
    },
  };
}

/**
 * Decision A22: a studio page cached before the deploy saves the old shapes
 * (MC `correctIndex`, a closest answer without a tolerance, questions and
 * rounds missing the v2 fields and settings). Each round and question goes through the read
 * normalisers first, so validation and the write see the v2 shape. Idempotent.
 */
export function normalisedInputRounds(
  rounds: QuizshowValidatableQuiz['rounds'],
): QuizshowRoundInput[] {
  return rounds.map((round) => ({
    ...round,
    settings: withRoundSettingsDefaults(round.settings),
    questions: round.questions.map((question) =>
      withSortedCorrectIndexes(
        normaliseStoredQuestion(
          question as unknown as Readonly<Record<string, unknown>>,
        ),
      ),
    ),
  }));
}

/**
 * The shape a write stores: normalised rows, and a screen language the quiz's
 * languages allow (contract 6.26). Each entry point runs it once and hands the
 * result to `assertPreparedShapeAllowed` and `writePreparedQuiz`.
 */
export function prepareQuizShape(shape: QuizshowQuizShape): QuizshowQuizShape {
  return {
    ...shape,
    screenLanguage: normalisedScreenLanguage(
      shape.languages,
      shape.screenLanguage,
    ),
    rounds: normalisedInputRounds(shape.rounds),
  };
}

/** The template line of a quiz (contract 6.25); null when either stamp is missing. */
function toSourceTemplateRef(
  row: SourceTemplateRow | undefined,
  copiedAt: Date | null,
): QuizshowSourceTemplateRef | null {
  if (!row || row.content_updated_at === null || copiedAt === null) {
    return null;
  }
  const lastPublishedAt = new Date(row.content_updated_at);
  return {
    templateId: row.template_id,
    title: { en: row.card_title_en, pt: row.card_title_pt },
    copiedAt: copiedAt.toISOString(),
    lastPublishedAt: lastPublishedAt.toISOString(),
    hasUpdate: lastPublishedAt.getTime() > copiedAt.getTime(),
    changeNote: { en: row.change_note_en, pt: row.change_note_pt },
  };
}

/**
 * A chosen wheel keeps the slices it brought: its slice count is pinned to
 * the size of its source range, so an Auto wheel (or one whose source range
 * ran short of its count) never takes a chosen row that follows it in the
 * append as one more slice. A wheel that brought fewer than the minimum is
 * left as it is, the same rule `withTrailingWheelPinned` keeps.
 */
function withChosenWheelPinned(
  sourceRounds: readonly QuizshowRoundInput[],
  round: QuizshowRoundInput,
  roundIndex: number,
): QuizshowRoundInput {
  if (!isWheelRoundKind(round.kind)) return round;
  const sliceCount = wheelSliceRoundIndexes(sourceRounds, roundIndex).length;
  if (sliceCount < QUIZSHOW_LIMITS.wheelSlicesMin) return round;
  return { ...round, settings: { ...round.settings, sliceCount } };
}

/**
 * The chosen source rows of an append, in source order (contract 6.28). null
 * takes every row as it is; a chosen wheel row brings every slice row of its
 * range and keeps that many slices (`withChosenWheelPinned`).
 * An empty choice names no round, so it gets the round refusal and writes nothing.
 */
function chosenSourceRounds(
  sourceRounds: readonly QuizshowRoundInput[],
  roundIndexes: readonly number[] | null | undefined,
): QuizshowRoundInput[] {
  if (roundIndexes === null || roundIndexes === undefined) {
    return [...sourceRounds];
  }
  if (roundIndexes.length === 0) {
    throw quizshowError('quizshow_import_round_not_found');
  }
  const chosenIndexes = new Set<number>();
  for (const roundIndex of roundIndexes) {
    if (
      !Number.isInteger(roundIndex) ||
      roundIndex < 0 ||
      roundIndex >= sourceRounds.length
    ) {
      throw quizshowError('quizshow_import_round_not_found');
    }
    chosenIndexes.add(roundIndex);
    for (const sliceRoundIndex of wheelSliceRoundIndexes(
      sourceRounds,
      roundIndex,
    )) {
      chosenIndexes.add(sliceRoundIndex);
    }
  }
  return sourceRounds.flatMap((round, roundIndex) =>
    chosenIndexes.has(roundIndex)
      ? [withChosenWheelPinned(sourceRounds, round, roundIndex)]
      : [],
  );
}

/**
 * Rows appended after a wheel would read as its slices when the wheel's range
 * reaches the end of the target (an Auto wheel takes up to 8). Pinning that
 * wheel's slice count to the slices it holds now keeps the target's meaning,
 * so every appended row stays a plain round, a source slice row chosen
 * without its own wheel included. A wheel holding fewer than the minimum
 * slices is left as it is: a pinned count under the minimum would refuse the
 * studio's next save, and that wheel already shows its too-few-slices problem.
 */
function withTrailingWheelPinned(
  rounds: readonly QuizshowRoundInput[],
): QuizshowRoundInput[] {
  const lastRowIndex = rounds.length - 1;
  const lastRow = rounds[lastRowIndex];
  if (!lastRow) return [...rounds];
  const wheelRowIndex = isWheelRoundKind(lastRow.kind)
    ? lastRowIndex
    : wheelRoundIndexOfRange(rounds, lastRowIndex);
  if (wheelRowIndex === null) return [...rounds];
  const sliceCount = wheelSliceRoundIndexes(rounds, wheelRowIndex).length;
  if (sliceCount < QUIZSHOW_LIMITS.wheelSlicesMin) return [...rounds];
  return rounds.map((round, roundIndex) =>
    roundIndex === wheelRowIndex
      ? { ...round, settings: { ...round.settings, sliceCount } }
      : round,
  );
}

/** The 422 of an append whose merged quiz breaks a limit; any other problem is the quiz invalid refusal. */
function assertAppendWithinLimits(shape: QuizshowValidatableQuiz): void {
  const problems = structuralProblems(shape);
  if (problems.length === 0) return;
  const problemCodes = new Set(problems.map((problem) => problem.code));
  for (const [problemCode, errorCode] of IMPORT_LIMIT_CODES) {
    if (problemCodes.has(problemCode)) throw quizshowError(errorCode);
  }
  throw quizshowErrorWithDetails('quizshow_quiz_invalid', { problems });
}

/**
 * Quiz authoring for an event: read, save (a full replace guarded by
 * `expectedUpdatedAt`), and import from a published template, another event of
 * the same organiser or a game the caller owns. Every event route needs an
 * organiser who is not playing an open session as a co-host.
 * The games service reuses the write, the import resolution, the 18+ rule and
 * the response builder for games.
 */
@Injectable()
export class QuizshowQuizService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly access: QuizshowAccessService,
  ) {}

  async getQuiz(slug: string, userId: string): Promise<QuizshowQuizResponse> {
    const event = await this.loadOrganisedEvent(slug, userId);
    return this.buildResponse(event);
  }

  async replaceQuiz(
    slug: string,
    userId: string,
    input: QuizshowQuizInputDto,
  ): Promise<QuizshowQuizResponse> {
    const event = await this.loadOrganisedEvent(slug, userId);
    // Sound because IsQuizshowAnswerForType fixes each answer's shape and structuralProblems rejects the rest.
    const inputShape = prepareQuizShape(input as unknown as QuizshowQuizShape);
    const target: QuizshowQuizTarget = { kind: 'event', event };
    this.assertPreparedShapeAllowed(target, inputShape);
    const storedQuiz = await this.loadQuiz(event.id);
    const storedMediaRefs = (storedQuiz?.rounds ?? []).flatMap((round) =>
      round.questions.map((question) => question.mediaRef),
    );
    for (const round of inputShape.rounds) {
      for (const question of round.questions) {
        assertNoForeignUploadIntroduced(
          userId,
          question.mediaRef,
          storedMediaRefs,
        );
      }
    }
    await this.writePreparedQuiz({
      target,
      userId,
      shape: inputShape,
      sourceTemplateId: storedQuiz?.sourceTemplateId ?? null,
      expectedUpdatedAt: input.expectedUpdatedAt,
    });
    return this.buildResponse(event);
  }

  async importQuiz(
    slug: string,
    userId: string,
    input: QuizshowImportDto,
  ): Promise<QuizshowQuizResponse> {
    const event = await this.loadOrganisedEvent(slug, userId);
    await this.runImport({
      target: { kind: 'event', event },
      userId,
      input,
      exclusion: { eventSlug: slug, gameId: null },
      keptTitle: null,
    });
    return this.buildResponse(event);
  }

  /**
   * Contract 6.28. Replace (the default) swaps the target's quiz for the
   * source's. Append keeps the target's title, languages, screen language
   * and rows, then adds the chosen source rows with fresh ids, guarded by the
   * target's `updatedAt` at the check here and again under the row lock.
   */
  async runImport(run: QuizshowImportRun): Promise<void> {
    const { target, userId, input } = run;
    const imported = await this.resolveImportShape(
      input,
      userId,
      run.exclusion,
    );
    if ((input.mode ?? 'replace') === 'replace') {
      const shape = prepareQuizShape(
        run.keptTitle === null
          ? imported.shape
          : { ...imported.shape, title: run.keptTitle },
      );
      this.assertPreparedShapeAllowed(target, shape);
      await this.writePreparedQuiz({
        target,
        userId,
        shape,
        sourceTemplateId: imported.sourceTemplateId,
        sourceTemplateCopiedAt: imported.sourceTemplateCopiedAt,
        expectedUpdatedAt: undefined,
      });
      return;
    }
    const stored = await this.loadTargetQuiz(target);
    const storedUpdatedAt = stored ? stored.quiz.updatedAt : null;
    // Decision A23: an append without a token answers the same conflict, so the studio reloads.
    if (
      input.expectedUpdatedAt === undefined ||
      input.expectedUpdatedAt !== storedUpdatedAt
    ) {
      throw await this.quizChangedError(
        stored?.record ?? null,
        this.dataSource.manager,
      );
    }
    const chosenRounds = chosenSourceRounds(
      imported.shape.rounds,
      input.roundIndexes,
    );
    const baseShape: QuizshowQuizShape = stored
      ? toQuizShape(stored.quiz)
      : {
          ...imported.shape,
          title: run.keptTitle ?? imported.shape.title,
          rounds: [],
        };
    const mergedShape = prepareQuizShape({
      ...baseShape,
      rounds: [...withTrailingWheelPinned(baseShape.rounds), ...chosenRounds],
    });
    assertAppendWithinLimits(mergedShape);
    this.assertAdultsRuleMet(target, mergedShape);
    // Contract 6.25: a template append names the source only on a quiz with none; one that has a source keeps its id.
    const storedSourceTemplateId = stored?.record.sourceTemplateId ?? null;
    const isNewTemplateSource =
      input.from === 'template' && storedSourceTemplateId === null;
    // An append from the quiz's own template brings its latest rows, so the copy is as new as this append (contract 13).
    const isOwnTemplateSource =
      input.from === 'template' &&
      storedSourceTemplateId !== null &&
      imported.sourceTemplateId === storedSourceTemplateId;
    await this.writePreparedQuiz({
      target,
      userId,
      shape: mergedShape,
      sourceTemplateId: isNewTemplateSource
        ? imported.sourceTemplateId
        : storedSourceTemplateId,
      sourceTemplateCopiedAt:
        isNewTemplateSource || isOwnTemplateSource
          ? imported.sourceTemplateCopiedAt
          : undefined,
      expectedUpdatedAt: input.expectedUpdatedAt,
    });
  }

  /** Events the caller organises with a quiz, newest first, then the caller's games. */
  async listImportSources(
    slug: string,
    userId: string,
  ): Promise<{ items: QuizshowImportSource[] }> {
    const event = await this.loadOrganisedEvent(slug, userId);
    const eventSources = await listOrganisedEventSources(this.dataSource, {
      userId,
      excludeEventSlug: slug,
      seriesId: event.seriesId ?? null,
    });
    const gameSources = await listOwnedGameSources(this.dataSource, {
      userId,
      excludeGameId: null,
    });
    return { items: [...eventSources, ...gameSources] };
  }

  /** For a game: the events the caller organises with a quiz, then the caller's other games. */
  async listGameImportSources(
    gameId: string,
    userId: string,
  ): Promise<QuizshowImportSource[]> {
    const eventSources = await listOrganisedEventSources(this.dataSource, {
      userId,
      excludeEventSlug: null,
      seriesId: null,
    });
    const gameSources = await listOwnedGameSources(this.dataSource, {
      userId,
      excludeGameId: gameId,
    });
    return [...eventSources, ...gameSources];
  }

  /**
   * The quiz an import copies: a published template, an event the caller organises
   * (never the excluded event), or a game the caller owns (never the excluded
   * game). Another member's game reads as a missing source.
   */
  async resolveImportShape(
    input: QuizshowImportDto,
    userId: string,
    exclusion: { eventSlug: string | null; gameId: string | null },
  ): Promise<QuizshowImportedShape> {
    if (input.from === 'template') {
      const { templateId } = input;
      if (templateId === undefined) {
        throw quizshowError('quizshow_template_not_found');
      }
      const templateQuiz = await this.loadPublishedTemplateQuiz(templateId);
      return {
        shape: toQuizShape(templateQuiz),
        sourceTemplateId: templateId,
        // Contract 6.25: the copy is as new as this import.
        sourceTemplateCopiedAt: new Date(),
      };
    }
    if (input.from === 'event') {
      if (
        exclusion.eventSlug !== null &&
        input.eventSlug === exclusion.eventSlug
      ) {
        throw quizshowError('quizshow_import_same_event');
      }
      const source = await this.loadOrganisedSourceQuiz(
        input.eventSlug,
        userId,
      );
      return {
        shape: toQuizShape(source.quiz),
        sourceTemplateId: source.record.sourceTemplateId,
        sourceTemplateCopiedAt: source.record.sourceTemplateCopiedAt,
      };
    }
    const source = await this.loadOwnedSourceQuiz(
      input.gameId,
      userId,
      exclusion.gameId,
    );
    return {
      shape: toQuizShape(source.quiz),
      sourceTemplateId: source.record.sourceTemplateId,
      sourceTemplateCopiedAt: source.record.sourceTemplateCopiedAt,
    };
  }

  /** The response of a game's builder; `isAdultsEvent` mirrors the game's 18+ switch. */
  async buildGameResponse(gameId: string): Promise<QuizshowGameResponse> {
    const record = await this.dataSource.manager.findOne(QuizshowQuizRecord, {
      where: { id: gameId },
    });
    if (!record || record.ownerUserId === null) {
      throw quizshowError('quizshow_game_not_found');
    }
    const [quiz, state] = await Promise.all([
      this.assembleQuiz(record, this.dataSource.manager),
      this.readGameResponseState(gameId),
    ]);
    return {
      gameId,
      isAdultsOnly: record.isAdultsOnly,
      quiz,
      problems: completenessProblems(quiz),
      isAdultsEvent: record.isAdultsOnly,
      liveSession: toLiveSessionRef(state, quiz.updatedAt),
      hasResults: state?.has_results === true,
      lastOpenSettings: record.lastOpenSettings ?? null,
    };
  }

  /** The stored quiz of an event with its rounds and questions, or null. */
  async loadQuiz(
    eventId: string,
    manager?: EntityManager,
  ): Promise<QuizshowQuiz | null> {
    const loaded = await this.loadQuizWithRecord(
      { eventId },
      manager ?? this.dataSource.manager,
    );
    return loaded?.quiz ?? null;
  }

  /** A stored quiz by its own id (a game's id is its quiz id), or null. */
  async loadQuizById(
    quizId: string,
    manager?: EntityManager,
  ): Promise<QuizshowQuiz | null> {
    const loaded = await this.loadQuizWithRecord(
      { id: quizId },
      manager ?? this.dataSource.manager,
    );
    return loaded?.quiz ?? null;
  }

  private async loadQuizWithRecord(
    where: { eventId: string } | { id: string },
    entityManager: EntityManager,
  ): Promise<LoadedQuiz | null> {
    const record = await entityManager.findOne(QuizshowQuizRecord, { where });
    if (!record) return null;
    return { record, quiz: await this.assembleQuiz(record, entityManager) };
  }

  /** The stored quiz an import writes into; a game id that names no row reads as game not found. */
  private async loadTargetQuiz(
    target: QuizshowImportRun['target'],
  ): Promise<LoadedQuiz | null> {
    if (target.kind === 'event') {
      return this.loadQuizWithRecord(
        { eventId: target.event.id },
        this.dataSource.manager,
      );
    }
    const loaded = await this.loadQuizWithRecord(
      { id: target.gameId },
      this.dataSource.manager,
    );
    if (!loaded) throw quizshowError('quizshow_game_not_found');
    return loaded;
  }

  /** A quiz row with its rounds, its questions in position order and its template line. */
  private async assembleQuiz(
    quiz: QuizshowQuizRecord,
    entityManager: EntityManager,
  ): Promise<QuizshowQuiz> {
    const rounds = await entityManager.find(QuizshowRoundRecord, {
      where: { quizId: quiz.id },
      order: { position: 'ASC' },
    });
    const [questions, sourceTemplate] = await Promise.all([
      rounds.length === 0
        ? Promise.resolve([])
        : entityManager
            .createQueryBuilder(QuizshowQuestionRecord, 'question')
            .where('question.roundId IN (:...roundIds)', {
              roundIds: rounds.map((round) => round.id),
            })
            .orderBy('question.position', 'ASC')
            .getMany(),
      this.readSourceTemplate(quiz, entityManager),
    ]);
    return toQuizshowQuiz(quiz, rounds, questions, sourceTemplate);
  }

  /** Contract 6.25; a quiz without a source or a copied stamp skips the query. */
  private async readSourceTemplate(
    quiz: QuizshowQuizRecord,
    entityManager: EntityManager,
  ): Promise<QuizshowSourceTemplateRef | null> {
    const copiedAt = quiz.sourceTemplateCopiedAt ?? null;
    if (quiz.sourceTemplateId === null || copiedAt === null) return null;
    const rows: SourceTemplateRow[] = await entityManager.query(
      SOURCE_TEMPLATE_SQL,
      [quiz.id],
    );
    return toSourceTemplateRef(rows[0], copiedAt);
  }

  /**
   * Contract 6.29 item 54: the 409 names who saved the stored quiz and when.
   * The name is null when the account is gone or no row is stored.
   */
  private async quizChangedError(
    stored: QuizshowQuizRecord | null,
    entityManager: EntityManager,
  ): Promise<HttpException> {
    const editorUserId = stored?.updatedByUserId ?? null;
    const nameRows: { first_name: string | null; last_name: string | null }[] =
      editorUserId === null
        ? []
        : await entityManager.query(QUIZ_EDITOR_NAME_SQL, [editorUserId]);
    const editorRow = nameRows[0];
    return quizshowErrorWithDetails('quizshow_quiz_changed', {
      // null when the target has no quiz: its token named one that is gone, or a save was expected on none.
      updatedAt: stored ? stored.updatedAt.toISOString() : null,
      updatedByName: editorRow
        ? nameOf(editorRow.first_name, editorRow.last_name)
        : null,
    } satisfies QuizshowQuizChangedDetails);
  }

  private async loadOrganisedEvent(
    slug: string,
    userId: string,
  ): Promise<Event> {
    const { event } = await this.access.loadViewableEvent(slug, userId);
    await this.access.assertOrganiser(event, userId);
    await this.access.assertNotCohostPlaying(event.id, userId);
    return event;
  }

  private async loadOrganisedSourceQuiz(
    sourceSlug: string | undefined,
    userId: string,
  ): Promise<LoadedQuiz> {
    const rows: { event_id: string }[] =
      sourceSlug === undefined
        ? []
        : await this.dataSource.query(ORGANISED_EVENT_BY_SLUG_SQL, [
            sourceSlug,
            userId,
          ]);
    const sourceEventId = rows[0]?.event_id;
    const source = sourceEventId
      ? await this.loadQuizWithRecord(
          { eventId: sourceEventId },
          this.dataSource.manager,
        )
      : null;
    if (!source) throw quizshowError('quizshow_import_source_not_found');
    return source;
  }

  /** The quiz of a published template; a draft or unknown id reads as template not found. */
  private async loadPublishedTemplateQuiz(
    templateId: string,
  ): Promise<QuizshowQuiz> {
    const rows: { quiz_id: string }[] = await this.dataSource.query(
      PUBLISHED_TEMPLATE_QUIZ_SQL,
      [templateId],
    );
    const templateQuizId = rows[0]?.quiz_id;
    const templateQuiz = templateQuizId
      ? await this.loadQuizById(templateQuizId)
      : null;
    if (!templateQuiz) throw quizshowError('quizshow_template_not_found');
    return templateQuiz;
  }

  /** A game of the caller other than the excluded one; every miss reads as a missing source. */
  private async loadOwnedSourceQuiz(
    sourceGameId: string | undefined,
    userId: string,
    excludedGameId: string | null,
  ): Promise<LoadedQuiz> {
    if (sourceGameId === undefined || sourceGameId === excludedGameId) {
      throw quizshowError('quizshow_import_source_not_found');
    }
    let sourceGame: QuizshowQuizRecord;
    try {
      sourceGame = await this.access.loadOwnedGame(sourceGameId, userId);
    } catch (error) {
      if (quizshowCodeOf(error) === 'quizshow_game_not_found') {
        throw quizshowError('quizshow_import_source_not_found');
      }
      throw error;
    }
    const source = await this.loadQuizWithRecord(
      { id: sourceGame.id },
      this.dataSource.manager,
    );
    if (!source) throw quizshowError('quizshow_import_source_not_found');
    return source;
  }

  /**
   * For a caller holding a raw shape (the templates service): normalises the
   * rows (decision A22), then runs `assertPreparedShapeAllowed`.
   */
  assertShapeAllowed(
    target: QuizshowQuizTarget,
    shape: QuizshowValidatableQuiz,
  ): void {
    this.assertPreparedShapeAllowed(target, {
      ...shape,
      rounds: normalisedInputRounds(shape.rounds),
    });
  }

  /**
   * Structural problems for every target, then the 18+ rule. The shape has
   * been through `prepareQuizShape` or `normalisedInputRounds` already.
   */
  assertPreparedShapeAllowed(
    target: QuizshowQuizTarget,
    shape: QuizshowValidatableQuiz,
  ): void {
    const problems = structuralProblems(shape);
    if (problems.length > 0) {
      throw quizshowErrorWithDetails('quizshow_quiz_invalid', { problems });
    }
    this.assertAdultsRuleMet(target, shape);
  }

  /**
   * The 18+ rule: an event needs its 18+ flag (the event code), a game needs
   * its 18+ switch (the game code), and a template allows adults rounds.
   */
  private assertAdultsRuleMet(
    target: QuizshowQuizTarget,
    shape: QuizshowValidatableQuiz,
  ): void {
    if (target.kind === 'template') return;
    if (!hasAdultsRound(shape)) return;
    if (target.kind === 'event') {
      if (!this.access.isAdultsEvent(target.event)) {
        throw quizshowError('quizshow_adults_round_needs_adults_event');
      }
      return;
    }
    if (!target.isAdultsOnly) {
      throw quizshowError('quizshow_game_adults_rounds_need_switch');
    }
  }

  /** For a caller holding a raw shape (the templates service): `prepareQuizShape`, then `writePreparedQuiz`. */
  writeQuiz(
    input: QuizshowQuizWriteInput,
    manager?: EntityManager,
  ): Promise<string> {
    return this.writePreparedQuiz(
      { ...input, shape: prepareQuizShape(input.shape) },
      manager,
    );
  }

  /**
   * Replaces the target's quiz with a prepared shape and returns the quiz id.
   * With a manager the write joins that transaction; without one it opens
   * its own, and a racing first save of an event answers as a stale quiz.
   */
  async writePreparedQuiz(
    input: QuizshowQuizWriteInput,
    manager?: EntityManager,
  ): Promise<string> {
    if (manager) return this.writeQuizRows(input, manager);
    try {
      return await this.dataSource.transaction((transactionManager) =>
        this.writeQuizRows(input, transactionManager),
      );
    } catch (error) {
      if (input.target.kind !== 'event' || !isEventUniqueViolation(error)) {
        throw error;
      }
      const winningQuiz = await this.dataSource.manager.findOne(
        QuizshowQuizRecord,
        { where: { eventId: input.target.event.id } },
      );
      throw await this.quizChangedError(winningQuiz, this.dataSource.manager);
    }
  }

  private async lockStoredQuiz(
    target: QuizshowQuizTarget,
    manager: EntityManager,
  ): Promise<QuizshowQuizRecord | null> {
    if (target.kind === 'new_game') return null;
    if (target.kind === 'event') {
      return manager.findOne(QuizshowQuizRecord, {
        where: { eventId: target.event.id },
        lock: { mode: 'for_no_key_update' },
      });
    }
    if (target.kind === 'template') {
      return manager.findOne(QuizshowQuizRecord, {
        where: { templateId: target.templateId },
        lock: { mode: 'for_no_key_update' },
      });
    }
    const storedGame = await manager.findOne(QuizshowQuizRecord, {
      where: { id: target.gameId },
      lock: { mode: 'for_no_key_update' },
    });
    if (!storedGame) throw quizshowError('quizshow_game_not_found');
    return storedGame;
  }

  private async writeQuizRows(
    input: QuizshowQuizWriteInput,
    manager: EntityManager,
  ): Promise<string> {
    const { target } = input;
    const stored = await this.lockStoredQuiz(target, manager);
    if (input.expectedUpdatedAt !== undefined) {
      const storedUpdatedAt = stored ? stored.updatedAt.toISOString() : null;
      if (storedUpdatedAt !== input.expectedUpdatedAt) {
        throw await this.quizChangedError(stored, manager);
      }
    }
    const { shape } = input;
    const quizColumns = {
      title: shape.title,
      languages: shape.languages,
      screenLanguage: shape.screenLanguage,
      sourceTemplateId: input.sourceTemplateId,
      ...(input.sourceTemplateCopiedAt === undefined
        ? {}
        : { sourceTemplateCopiedAt: input.sourceTemplateCopiedAt }),
      updatedByUserId: input.userId,
      updatedAt: new Date(),
      ...(target.kind === 'game' || target.kind === 'new_game'
        ? { isAdultsOnly: target.isAdultsOnly }
        : {}),
    };
    let quizId: string;
    if (stored) {
      quizId = stored.id;
      await manager.update(QuizshowQuizRecord, { id: quizId }, quizColumns);
      await manager.delete(QuizshowRoundRecord, { quizId });
    } else {
      const scopeColumns =
        target.kind === 'event'
          ? { eventId: target.event.id }
          : target.kind === 'new_game'
            ? { eventId: null, ownerUserId: target.ownerUserId }
            : target.kind === 'template'
              ? { eventId: null, templateId: target.templateId }
              : {};
      const insertResult = await manager.insert(QuizshowQuizRecord, {
        ...quizColumns,
        ...scopeColumns,
        createdByUserId: input.userId,
      });
      quizId = (insertResult.identifiers[0] as { id: string }).id;
    }
    const rows = buildRoundRows(quizId, shape.rounds);
    if (rows.rounds.length > 0) {
      await manager.insert(QuizshowRoundRecord, rows.rounds);
    }
    if (rows.questions.length > 0) {
      // The jsonb answer is a plain object; TypeORM's deep partial cannot map its union.
      await manager.insert(
        QuizshowQuestionRecord,
        rows.questions as QueryDeepPartialEntity<QuizshowQuestionRecord>[],
      );
    }
    return quizId;
  }

  private async readGameResponseState(
    gameId: string,
  ): Promise<QuizResponseStateRow | undefined> {
    const rows: QuizResponseStateRow[] = await this.dataSource.query(
      GAME_RESPONSE_STATE_SQL,
      [gameId],
    );
    return rows[0];
  }

  private async readResponseState(
    eventId: string,
  ): Promise<QuizResponseStateRow | undefined> {
    const rows: QuizResponseStateRow[] = await this.dataSource.query(
      QUIZ_RESPONSE_STATE_SQL,
      [eventId],
    );
    return rows[0];
  }

  private async buildResponse(event: Event): Promise<QuizshowQuizResponse> {
    const [loaded, state] = await Promise.all([
      this.loadQuizWithRecord({ eventId: event.id }, this.dataSource.manager),
      this.readResponseState(event.id),
    ]);
    const quiz = loaded?.quiz ?? null;
    return {
      quiz,
      problems: quiz ? completenessProblems(quiz) : [],
      isAdultsEvent: this.access.isAdultsEvent(event),
      liveSession: toLiveSessionRef(state, quiz?.updatedAt ?? null),
      hasResults: state?.has_results === true,
      lastOpenSettings: loaded?.record.lastOpenSettings ?? null,
    };
  }
}
