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
import { quizshowError, quizshowErrorWithDetails } from './quizshow-errors';
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
import {
  QUIZSHOW_LIMITS,
  type QuizshowImportSource,
  type QuizshowLiveSessionRef,
  type QuizshowQuiz,
  type QuizshowQuizResponse,
  type QuizshowStarterPackCard,
  type QuizshowStarterPackKey,
} from './quizshow.contract';

const QUIZ_EVENT_UNIQUE_CONSTRAINT = 'UQ_quizshow_quizzes_event_id';

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

/** $1 current slug, $2 caller id, $3 current series id (nullable), $4 limit. */
const IMPORT_SOURCES_SQL = `
  SELECT
    "event"."slug" AS "event_slug",
    "event"."title" AS "event_title",
    "event"."start_at" AS "start_at",
    "quiz"."title" AS "quiz_title",
    (
      SELECT COUNT(*)::int FROM "quizshow_rounds" "round"
      WHERE "round"."quiz_id" = "quiz"."id"
    ) AS "round_count",
    (
      SELECT COUNT(*)::int
      FROM "quizshow_questions" "question"
      INNER JOIN "quizshow_rounds" "round" ON "round"."id" = "question"."round_id"
      WHERE "round"."quiz_id" = "quiz"."id"
    ) AS "question_count",
    EXISTS (
      SELECT 1 FROM "quizshow_rounds" "round"
      WHERE "round"."quiz_id" = "quiz"."id"
        AND "round"."content_label" = 'adults'
    ) AS "has_adults_rounds",
    COALESCE($3::uuid IS NOT NULL AND "event"."series_id" = $3::uuid, false) AS "is_same_series"
  FROM "events" "event"
  INNER JOIN "quizshow_quizzes" "quiz" ON "quiz"."event_id" = "event"."id"
  WHERE "event"."slug" <> $1
    AND (
      "event"."host_id" = $2
      OR EXISTS (
        SELECT 1 FROM "event_cohosts" "cohost"
        WHERE "cohost"."event_id" = "event"."id" AND "cohost"."user_id" = $2
      )
    )
  ORDER BY "event"."start_at" DESC, "event"."id"
  LIMIT $4
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

interface ImportSourceRow {
  event_slug: string;
  event_title: string;
  start_at: Date | string;
  quiz_title: string;
  round_count: number;
  question_count: number;
  has_adults_rounds: boolean;
  is_same_series: boolean;
}

interface QuizWriteInput {
  event: Event;
  userId: string;
  shape: QuizshowQuizShape & { screenLanguage: QuizshowQuiz['screenLanguage'] };
  starterPackKey: QuizshowStarterPackKey | null;
  /** undefined skips the stale check (imports). */
  expectedUpdatedAt: string | null | undefined;
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
 * Quiz authoring for an event: read, save (a full replace guarded by
 * `expectedUpdatedAt`), and import from a starter pack or another event of
 * the same organiser. Every route but the pack list needs an organiser who is
 * not playing an open session as a co-host.
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
    const inputShape = input as unknown as QuizWriteInput['shape'];
    this.assertShapeAllowed(event, inputShape);
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
      event,
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
    let shape: QuizshowQuizShape & {
      screenLanguage: QuizshowQuiz['screenLanguage'];
    };
    let starterPackKey: QuizshowStarterPackKey | null;
    if (input.from === 'pack') {
      const pack =
        input.packKey === undefined ? null : starterPackByKey(input.packKey);
      if (!pack) throw quizshowError('quizshow_pack_not_found');
      shape = pack.quiz;
      starterPackKey = pack.key;
    } else {
      if (input.eventSlug === slug) {
        throw quizshowError('quizshow_import_same_event');
      }
      const sourceQuiz = await this.loadOrganisedSourceQuiz(
        input.eventSlug,
        userId,
      );
      shape = toQuizShape(sourceQuiz);
      starterPackKey = sourceQuiz.starterPackKey;
    }
    this.assertShapeAllowed(event, shape);
    await this.writeQuiz({
      event,
      userId,
      shape,
      starterPackKey,
      expectedUpdatedAt: undefined,
    });
    return this.buildResponse(event);
  }

  async listImportSources(
    slug: string,
    userId: string,
  ): Promise<{ items: QuizshowImportSource[] }> {
    const event = await this.loadOrganisedEvent(slug, userId);
    const rows: ImportSourceRow[] = await this.dataSource.query(
      IMPORT_SOURCES_SQL,
      [slug, userId, event.seriesId ?? null, QUIZSHOW_LIMITS.importSourcesMax],
    );
    return {
      items: rows.map((row) => ({
        eventSlug: row.event_slug,
        eventTitle: row.event_title,
        startAt: toIsoString(row.start_at),
        quizTitle: row.quiz_title,
        roundCount: row.round_count,
        questionCount: row.question_count,
        hasAdultsRounds: row.has_adults_rounds,
        isSameSeries: row.is_same_series,
      })),
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
    if (!quiz) return null;
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

  /** Structural problems and the 18+ rule. */
  private assertShapeAllowed(event: Event, shape: QuizshowQuizShape): void {
    const problems = structuralProblems(shape);
    if (problems.length > 0) {
      throw quizshowErrorWithDetails('quizshow_quiz_invalid', { problems });
    }
    if (hasAdultsRound(shape) && !this.access.isAdultsEvent(event)) {
      throw quizshowError('quizshow_adults_round_needs_adults_event');
    }
  }

  private async writeQuiz(input: QuizWriteInput): Promise<void> {
    try {
      await this.dataSource.transaction(async (manager) => {
        const stored = await manager.findOne(QuizshowQuizRecord, {
          where: { eventId: input.event.id },
          lock: { mode: 'for_no_key_update' },
        });
        if (input.expectedUpdatedAt !== undefined) {
          const storedUpdatedAt = stored
            ? stored.updatedAt.toISOString()
            : null;
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
        };
        let quizId: string;
        if (stored) {
          quizId = stored.id;
          await manager.update(QuizshowQuizRecord, { id: quizId }, quizColumns);
          await manager.delete(QuizshowRoundRecord, { quizId });
        } else {
          const insertResult = await manager.insert(QuizshowQuizRecord, {
            ...quizColumns,
            eventId: input.event.id,
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
      });
    } catch (error) {
      if (!isEventUniqueViolation(error)) throw error;
      const winningQuiz = await this.loadQuiz(input.event.id);
      throw quizshowErrorWithDetails('quizshow_quiz_changed', {
        updatedAt: winningQuiz?.updatedAt ?? null,
      });
    }
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
    const liveSession: QuizshowLiveSessionRef | null =
      state?.session_id &&
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
    return {
      quiz,
      problems: quiz ? completenessProblems(quiz) : [],
      isAdultsEvent: this.access.isAdultsEvent(event),
      liveSession,
      hasResults: state?.has_results === true,
    };
  }
}
