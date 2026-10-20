import { Injectable } from '@nestjs/common';
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
  toQuizShape,
  toQuizshowQuiz,
} from './quizshow-quiz-mapping';
import {
  completenessProblems,
  hasAdultsRound,
  structuralProblems,
  type QuizshowQuizShape,
} from './quizshow-quiz-validation';
import {
  QUIZSHOW_STARTER_PACKS,
  starterPackByKey,
  toStarterPackCard,
} from './quizshow-starter-packs';
import type {
  QuizshowGameResponse,
  QuizshowImportSource,
  QuizshowLiveSessionRef,
  QuizshowQuiz,
  QuizshowQuizResponse,
  QuizshowStarterPackCard,
  QuizshowStarterPackKey,
  QuizshowStarterPackQuiz,
} from './quizshow.contract';

const QUIZ_EVENT_UNIQUE_CONSTRAINT = 'UQ_quizshow_quizzes_event_id';

/** Where a quiz write lands: an event's quiz, a stored game, or a game created now. */
export type QuizshowQuizTarget =
  | { kind: 'event'; event: Event }
  | { kind: 'game'; gameId: string; isAdultsOnly: boolean }
  | { kind: 'new_game'; ownerUserId: string; isAdultsOnly: boolean };

export interface QuizshowQuizWriteInput {
  target: QuizshowQuizTarget;
  userId: string;
  shape: QuizshowStarterPackQuiz;
  starterPackKey: QuizshowStarterPackKey | null;
  /** undefined skips the stale check (imports and new games). */
  expectedUpdatedAt: string | null | undefined;
}

export interface QuizshowImportedShape {
  shape: QuizshowStarterPackQuiz;
  starterPackKey: QuizshowStarterPackKey | null;
}

/** $1 game quiz id: the open session with its player count, and whether kept results exist. */
const GAME_RESPONSE_STATE_SQL = `
  SELECT
    "open_session"."id" AS "session_id",
    "open_session"."join_code" AS "join_code",
    "open_session"."status" AS "status",
    "open_session"."play_mode" AS "play_mode",
    "open_session"."started_at" AS "started_at",
    "open_session"."player_count" AS "player_count",
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

/** $1 event id: the open session with its player count, and whether kept results exist. */
const QUIZ_RESPONSE_STATE_SQL = `
  SELECT
    "open_session"."id" AS "session_id",
    "open_session"."join_code" AS "join_code",
    "open_session"."status" AS "status",
    "open_session"."play_mode" AS "play_mode",
    "open_session"."started_at" AS "started_at",
    "open_session"."player_count" AS "player_count",
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

interface QuizResponseStateRow {
  session_id: string | null;
  join_code: string | null;
  status: QuizshowLiveSessionRef['status'] | null;
  play_mode: QuizshowLiveSessionRef['playMode'] | null;
  started_at: Date | string | null;
  player_count: number | null;
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

function toLiveSessionRef(
  state: QuizResponseStateRow | undefined,
): QuizshowLiveSessionRef | null {
  return state?.session_id &&
    state.join_code &&
    state.status &&
    state.play_mode &&
    state.started_at
    ? {
        sessionId: state.session_id,
        joinCode: state.join_code,
        status: state.status,
        playMode: state.play_mode,
        playerCount: state.player_count ?? 0,
        startedAt: toIsoString(state.started_at),
      }
    : null;
}

/**
 * Quiz authoring for an event: read, save (a full replace guarded by
 * `expectedUpdatedAt`), and import from a starter pack, another event of the
 * same organiser or a game the caller owns. Every event route but the pack
 * list needs an organiser who is not playing an open session as a co-host.
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
    const inputShape = input as unknown as QuizshowStarterPackQuiz;
    const target: QuizshowQuizTarget = { kind: 'event', event };
    this.assertShapeAllowed(target, inputShape);
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
    await this.writeQuiz({
      target,
      userId,
      shape: inputShape,
      starterPackKey: storedQuiz?.starterPackKey ?? null,
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
    const { shape, starterPackKey } = await this.resolveImportShape(
      input,
      userId,
      { eventSlug: slug, gameId: null },
    );
    const target: QuizshowQuizTarget = { kind: 'event', event };
    this.assertShapeAllowed(target, shape);
    await this.writeQuiz({
      target,
      userId,
      shape,
      starterPackKey,
      expectedUpdatedAt: undefined,
    });
    return this.buildResponse(event);
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
   * The quiz an import copies: a starter pack, an event the caller organises
   * (never the excluded event), or a game the caller owns (never the excluded
   * game). Another member's game reads as a missing source.
   */
  async resolveImportShape(
    input: QuizshowImportDto,
    userId: string,
    exclusion: { eventSlug: string | null; gameId: string | null },
  ): Promise<QuizshowImportedShape> {
    if (input.from === 'pack') {
      const pack =
        input.packKey === undefined ? null : starterPackByKey(input.packKey);
      if (!pack) throw quizshowError('quizshow_pack_not_found');
      return { shape: pack.quiz, starterPackKey: pack.key };
    }
    if (input.from === 'event') {
      if (
        exclusion.eventSlug !== null &&
        input.eventSlug === exclusion.eventSlug
      ) {
        throw quizshowError('quizshow_import_same_event');
      }
      const sourceQuiz = await this.loadOrganisedSourceQuiz(
        input.eventSlug,
        userId,
      );
      return {
        shape: toQuizShape(sourceQuiz),
        starterPackKey: sourceQuiz.starterPackKey,
      };
    }
    const sourceQuiz = await this.loadOwnedSourceQuiz(
      input.gameId,
      userId,
      exclusion.gameId,
    );
    return {
      shape: toQuizShape(sourceQuiz),
      starterPackKey: sourceQuiz.starterPackKey,
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
      liveSession: toLiveSessionRef(state),
      hasResults: state?.has_results === true,
    };
  }

  listPacks(): { items: QuizshowStarterPackCard[] } {
    return { items: QUIZSHOW_STARTER_PACKS.map(toStarterPackCard) };
  }

  /** The stored quiz of an event with its rounds and questions, or null. */
  async loadQuiz(
    eventId: string,
    manager?: EntityManager,
  ): Promise<QuizshowQuiz | null> {
    const entityManager = manager ?? this.dataSource.manager;
    const quiz = await entityManager.findOne(QuizshowQuizRecord, {
      where: { eventId },
    });
    return quiz ? this.assembleQuiz(quiz, entityManager) : null;
  }

  /** A stored quiz by its own id (a game's id is its quiz id), or null. */
  async loadQuizById(
    quizId: string,
    manager?: EntityManager,
  ): Promise<QuizshowQuiz | null> {
    const entityManager = manager ?? this.dataSource.manager;
    const quiz = await entityManager.findOne(QuizshowQuizRecord, {
      where: { id: quizId },
    });
    return quiz ? this.assembleQuiz(quiz, entityManager) : null;
  }

  /** A quiz row with its rounds and questions in position order. */
  private async assembleQuiz(
    quiz: QuizshowQuizRecord,
    entityManager: EntityManager,
  ): Promise<QuizshowQuiz> {
    const rounds = await entityManager.find(QuizshowRoundRecord, {
      where: { quizId: quiz.id },
      order: { position: 'ASC' },
    });
    const questions =
      rounds.length === 0
        ? []
        : await entityManager
            .createQueryBuilder(QuizshowQuestionRecord, 'question')
            .where('question.roundId IN (:...roundIds)', {
              roundIds: rounds.map((round) => round.id),
            })
            .orderBy('question.position', 'ASC')
            .getMany();
    return toQuizshowQuiz(quiz, rounds, questions);
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
  ): Promise<QuizshowQuiz> {
    const rows: { event_id: string }[] =
      sourceSlug === undefined
        ? []
        : await this.dataSource.query(ORGANISED_EVENT_BY_SLUG_SQL, [
            sourceSlug,
            userId,
          ]);
    const sourceEventId = rows[0]?.event_id;
    const sourceQuiz = sourceEventId
      ? await this.loadQuiz(sourceEventId)
      : null;
    if (!sourceQuiz) throw quizshowError('quizshow_import_source_not_found');
    return sourceQuiz;
  }

  /** A game of the caller other than the excluded one; every miss reads as a missing source. */
  private async loadOwnedSourceQuiz(
    sourceGameId: string | undefined,
    userId: string,
    excludedGameId: string | null,
  ): Promise<QuizshowQuiz> {
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
    const sourceQuiz = await this.loadQuizById(sourceGame.id);
    if (!sourceQuiz) throw quizshowError('quizshow_import_source_not_found');
    return sourceQuiz;
  }

  /**
   * Structural problems and the 18+ rule: an event needs its 18+ flag
   * (the event code), a game needs its 18+ switch (the game code).
   */
  assertShapeAllowed(
    target: QuizshowQuizTarget,
    shape: QuizshowQuizShape,
  ): void {
    const problems = structuralProblems(shape);
    if (problems.length > 0) {
      throw quizshowErrorWithDetails('quizshow_quiz_invalid', { problems });
    }
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

  /**
   * Replaces the target's quiz with the shape and returns the quiz id. With a
   * manager the write joins that transaction; without one it opens its own,
   * and a racing first save of an event answers as a stale quiz.
   */
  async writeQuiz(
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
      const winningQuiz = await this.loadQuiz(input.target.event.id);
      throw quizshowErrorWithDetails('quizshow_quiz_changed', {
        updatedAt: winningQuiz?.updatedAt ?? null,
      });
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
        throw quizshowErrorWithDetails('quizshow_quiz_changed', {
          updatedAt: storedUpdatedAt,
        });
      }
    }
    const quizColumns = {
      title: input.shape.title,
      languages: input.shape.languages,
      screenLanguage: input.shape.screenLanguage,
      starterPackKey: input.starterPackKey,
      updatedByUserId: input.userId,
      updatedAt: new Date(),
      ...(target.kind === 'event' ? {} : { isAdultsOnly: target.isAdultsOnly }),
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
            : {};
      const insertResult = await manager.insert(QuizshowQuizRecord, {
        ...quizColumns,
        ...scopeColumns,
        createdByUserId: input.userId,
      });
      quizId = (insertResult.identifiers[0] as { id: string }).id;
    }
    const rows = buildRoundRows(quizId, input.shape.rounds);
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
    const [quiz, state] = await Promise.all([
      this.loadQuiz(event.id),
      this.readResponseState(event.id),
    ]);
    return {
      quiz,
      problems: quiz ? completenessProblems(quiz) : [],
      isAdultsEvent: this.access.isAdultsEvent(event),
      liveSession: toLiveSessionRef(state),
      hasResults: state?.has_results === true,
    };
  }
}
