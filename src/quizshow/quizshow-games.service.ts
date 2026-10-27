import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { DataSource, EntityManager } from 'typeorm';
import { ModAuditService } from '../moderation/mod-audit.service';
import { assertNoForeignUploadIntroduced } from '../storage/assert-no-foreign-upload';
import { QuizshowQuizRecord } from './entities/quizshow-quiz.entity';
import { QuizshowAccessService } from './quizshow-access.service';
import {
  QuizshowCreateGameDto,
  QuizshowGameInputDto,
} from './dto/quizshow-game.dto';
import { QuizshowImportDto } from './dto/quizshow-import.dto';
import { QuizshowStaffActionDto } from './dto/quizshow-staff-action.dto';
import { quizshowError } from './quizshow-errors';
import { toQuizShape } from './quizshow-quiz-mapping';
import {
  QuizshowQuizService,
  type QuizshowQuizTarget,
} from './quizshow-quiz.service';
import { hasAdultsRound } from './quizshow-quiz-validation';
import { QuizshowRuntimeService } from './quizshow-runtime.service';
import {
  QUIZSHOW_GAMES_PER_MEMBER_MAX,
  type QuizshowGameListResponse,
  type QuizshowGameResponse,
  type QuizshowGameSummary,
  type QuizshowImportSource,
  type QuizshowLiveSessionRef,
  type QuizshowQuizShape,
} from './quizshow.contract';

/** Moderation audit action codes for staff takedowns of a reported game. */
export const QUIZSHOW_AUDIT_ACTIONS = {
  gameEnded: 'quizshow_game_ended',
  gameDeleted: 'quizshow_game_deleted',
} as const;

/** The per-member advisory lock key prefix around game creation. */
export const QUIZSHOW_GAMES_LOCK_PREFIX = 'quizshow_games:';

const MEMBER_LOCK_SQL = 'SELECT pg_advisory_xact_lock(hashtext($1))';

/** $1 owner id: how many games the member keeps. */
const GAME_COUNT_SQL = `
  SELECT COUNT(*)::int AS "game_count"
  FROM "quizshow_quizzes" "quiz"
  WHERE "quiz"."owner_user_id" = $1
`;

/**
 * $1 owner id, $2 limit: the member's games, last edited first, with their
 * counts, the open session with its player count, and whether kept results exist.
 */
export const GAME_LIST_SQL = `
  SELECT
    "quiz"."id" AS "id",
    "quiz"."title" AS "title",
    "quiz"."is_adults_only" AS "is_adults_only",
    "quiz"."updated_at" AS "updated_at",
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
      WHERE "kept_session"."quiz_id" = "quiz"."id"
        AND "kept_session"."results_kept" = true
    ) AS "has_results"
  FROM "quizshow_quizzes" "quiz"
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
    WHERE "session"."quiz_id" = "quiz"."id"
      AND "session"."status" IN ('lobby', 'running', 'paused')
    LIMIT 1
  ) AS "open_session" ON true
  WHERE "quiz"."owner_user_id" = $1
  ORDER BY "quiz"."updated_at" DESC, "quiz"."id"
  LIMIT $2
`;

/** $1 session id: the game the session plays, with its owner, when it plays a game. */
export const SESSION_GAME_SQL = `
  SELECT "quiz"."id" AS "game_id", "quiz"."owner_user_id" AS "owner_user_id"
  FROM "quizshow_sessions" "session"
  INNER JOIN "quizshow_quizzes" "quiz" ON "quiz"."id" = "session"."quiz_id"
  WHERE "session"."id" = $1
    AND "quiz"."owner_user_id" IS NOT NULL
`;

/**
 * $1 report id, $2 session id: the report when it is a game report about this
 * session. The subject id compares case blind, as the persona post takedown does.
 */
export const SESSION_REPORT_SQL = `
  SELECT "report"."id" AS "id"
  FROM "reports" "report"
  WHERE "report"."id" = $1
    AND "report"."subject_type" = 'quizshow_game'
    AND lower("report"."subject_id") = lower($2)
`;

interface SessionGameRow {
  game_id: string;
  owner_user_id: string;
}

interface GameListRow {
  id: string;
  title: string;
  is_adults_only: boolean;
  updated_at: Date | string;
  round_count: number;
  question_count: number;
  session_id: string | null;
  join_code: string | null;
  status: QuizshowLiveSessionRef['status'] | null;
  play_mode: QuizshowLiveSessionRef['playMode'] | null;
  started_at: Date | string | null;
  player_count: number | null;
  has_results: boolean;
}

interface NewGamePlan {
  shape: QuizshowQuizShape;
  sourceTemplateId: string | null;
  isAdultsOnly: boolean;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toGameSummary(row: GameListRow): QuizshowGameSummary {
  const liveSession: QuizshowLiveSessionRef | null =
    row.session_id &&
    row.join_code &&
    row.status &&
    row.play_mode &&
    row.started_at
      ? {
          sessionId: row.session_id,
          joinCode: row.join_code,
          status: row.status,
          playMode: row.play_mode,
          playerCount: row.player_count ?? 0,
          startedAt: toIsoString(row.started_at),
        }
      : null;
  return {
    id: row.id,
    title: row.title,
    roundCount: row.round_count,
    questionCount: row.question_count,
    isAdultsOnly: row.is_adults_only,
    liveSession,
    hasResults: row.has_results === true,
    updatedAt: toIsoString(row.updated_at),
  };
}

/**
 * My games: the quizzes a member owns outside any event. Every route answers
 * game not found for a game the caller does not own. Create and duplicate
 * count the member's games under a per-member lock; delete ends the game's
 * open session as abandoned first. Staff end or delete a reported game by
 * the reported session id.
 */
@Injectable()
export class QuizshowGamesService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly access: QuizshowAccessService,
    private readonly quizzes: QuizshowQuizService,
    private readonly runtime: QuizshowRuntimeService,
    private readonly modAudit: ModAuditService,
  ) {}

  async listGames(userId: string): Promise<QuizshowGameListResponse> {
    const rows: GameListRow[] = await this.dataSource.query(GAME_LIST_SQL, [
      userId,
      QUIZSHOW_GAMES_PER_MEMBER_MAX,
    ]);
    return {
      games: rows.map(toGameSummary),
      limit: QUIZSHOW_GAMES_PER_MEMBER_MAX,
    };
  }

  /** A blank game, or a copy of a source; the switch turns on when the source holds an adults round. */
  async createGame(
    userId: string,
    input: QuizshowCreateGameDto,
  ): Promise<QuizshowGameResponse> {
    const title = input.title.trim();
    if (input.source === null) {
      return this.insertNewGame(userId, {
        shape: { title, languages: 'both', screenLanguage: 'en', rounds: [] },
        sourceTemplateId: null,
        isAdultsOnly: false,
      });
    }
    const { shape, sourceTemplateId } = await this.quizzes.resolveImportShape(
      input.source,
      userId,
      { eventSlug: null, gameId: null },
    );
    return this.insertNewGame(userId, {
      shape: { ...shape, title },
      sourceTemplateId,
      isAdultsOnly: hasAdultsRound(shape),
    });
  }

  async getGame(gameId: string, userId: string): Promise<QuizshowGameResponse> {
    await this.access.loadOwnedGame(gameId, userId);
    return this.quizzes.buildGameResponse(gameId);
  }

  /** A full replace guarded by `expectedUpdatedAt`, with the 18+ switch from the input. */
  async replaceGame(
    gameId: string,
    userId: string,
    input: QuizshowGameInputDto,
  ): Promise<QuizshowGameResponse> {
    await this.access.loadOwnedGame(gameId, userId);
    // Sound because IsQuizshowAnswerForType fixes each answer's shape and structuralProblems rejects the rest.
    const inputShape = input as unknown as QuizshowQuizShape;
    const target: QuizshowQuizTarget = {
      kind: 'game',
      gameId,
      isAdultsOnly: input.isAdultsOnly,
    };
    this.quizzes.assertShapeAllowed(target, inputShape);
    const storedQuiz = await this.quizzes.loadQuizById(gameId);
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
    await this.quizzes.writeQuiz({
      target,
      userId,
      shape: inputShape,
      sourceTemplateId: storedQuiz?.sourceTemplateId ?? null,
      expectedUpdatedAt: input.expectedUpdatedAt,
    });
    return this.quizzes.buildGameResponse(gameId);
  }

  /** Ends the game's open session as abandoned, then deletes the game with its sessions and results. */
  async deleteGame(gameId: string, userId: string): Promise<void> {
    await this.access.loadOwnedGame(gameId, userId);
    await this.runtime.abandonSessionsOfGames([gameId], Date.now());
    await this.dataSource.manager.delete(QuizshowQuizRecord, {
      id: gameId,
      ownerUserId: userId,
    });
  }

  /** A new game with the same title, switch and rounds; sessions and results stay with the source. */
  async duplicateGame(
    gameId: string,
    userId: string,
  ): Promise<QuizshowGameResponse> {
    const sourceGame = await this.access.loadOwnedGame(gameId, userId);
    const sourceQuiz = await this.quizzes.loadQuizById(sourceGame.id);
    if (!sourceQuiz) throw quizshowError('quizshow_game_not_found');
    return this.insertNewGame(userId, {
      shape: { ...toQuizShape(sourceQuiz), title: sourceGame.title },
      sourceTemplateId: sourceQuiz.sourceTemplateId,
      isAdultsOnly: sourceGame.isAdultsOnly,
    });
  }

  /** Replaces the rounds, languages and source template from the source; the game keeps its own title and switch. */
  async importIntoGame(
    gameId: string,
    userId: string,
    input: QuizshowImportDto,
  ): Promise<QuizshowGameResponse> {
    const game = await this.access.loadOwnedGame(gameId, userId);
    const { shape, sourceTemplateId } = await this.quizzes.resolveImportShape(
      input,
      userId,
      { eventSlug: null, gameId },
    );
    const gameShape: QuizshowQuizShape = { ...shape, title: game.title };
    const target: QuizshowQuizTarget = {
      kind: 'game',
      gameId,
      isAdultsOnly: game.isAdultsOnly,
    };
    this.quizzes.assertShapeAllowed(target, gameShape);
    await this.quizzes.writeQuiz({
      target,
      userId,
      shape: gameShape,
      sourceTemplateId,
      expectedUpdatedAt: undefined,
    });
    return this.quizzes.buildGameResponse(gameId);
  }

  /** The events the caller organises with a quiz, then the caller's other games. */
  async listImportSources(
    gameId: string,
    userId: string,
  ): Promise<QuizshowImportSource[]> {
    await this.access.loadOwnedGame(gameId, userId);
    return this.quizzes.listGameImportSources(gameId, userId);
  }

  /**
   * Staff: ends the open session of the reported session's game (no open
   * session is a no-op) and writes the audit row against the game owner.
   */
  async endGameSessionAsStaff(
    actorId: string,
    sessionId: string,
    input: QuizshowStaffActionDto,
  ): Promise<void> {
    const sessionGame = await this.loadGameOfSession(sessionId);
    await this.assertReportOfSession(input.reportId, sessionId);
    await this.runtime.abandonSessionsOfGames([sessionGame.gameId], Date.now());
    await this.modAudit.writeAuditLog(
      input.reportId ?? null,
      actorId,
      QUIZSHOW_AUDIT_ACTIONS.gameEnded,
      undefined,
      `${sessionId}: ${input.reason}`,
      undefined,
      undefined,
      sessionGame.ownerUserId,
    );
  }

  /**
   * Staff: ends any open session of the reported session's game, then deletes
   * the game and writes the audit row against the game owner in one transaction.
   */
  async deleteGameAsStaff(
    actorId: string,
    sessionId: string,
    input: QuizshowStaffActionDto,
  ): Promise<void> {
    const sessionGame = await this.loadGameOfSession(sessionId);
    await this.assertReportOfSession(input.reportId, sessionId);
    await this.runtime.abandonSessionsOfGames([sessionGame.gameId], Date.now());
    await this.dataSource.transaction(async (manager: EntityManager) => {
      await manager.delete(QuizshowQuizRecord, { id: sessionGame.gameId });
      await this.modAudit.writeAuditLog(
        input.reportId ?? null,
        actorId,
        QUIZSHOW_AUDIT_ACTIONS.gameDeleted,
        undefined,
        `${sessionId}: ${input.reason}`,
        undefined,
        manager,
        sessionGame.ownerUserId,
      );
    });
  }

  /** The game a session plays and its owner; an unknown session, an event session or a deleted game reads as game not found. */
  private async loadGameOfSession(
    sessionId: string,
  ): Promise<{ gameId: string; ownerUserId: string }> {
    if (!isUUID(sessionId)) throw quizshowError('quizshow_game_not_found');
    const rows: SessionGameRow[] = await this.dataSource.query(
      SESSION_GAME_SQL,
      [sessionId],
    );
    const row = rows[0];
    if (!row?.game_id) throw quizshowError('quizshow_game_not_found');
    return { gameId: row.game_id, ownerUserId: row.owner_user_id };
  }

  /** A given report id must name a game report about this session; any mismatch reads as game not found. */
  private async assertReportOfSession(
    reportId: string | undefined,
    sessionId: string,
  ): Promise<void> {
    if (reportId === undefined) return;
    if (!isUUID(reportId)) throw quizshowError('quizshow_game_not_found');
    const rows: { id: string }[] = await this.dataSource.query(
      SESSION_REPORT_SQL,
      [reportId, sessionId],
    );
    if (rows.length === 0) throw quizshowError('quizshow_game_not_found');
  }

  /** Lock, count, refuse at the limit, then write the new game in the same transaction. */
  private async insertNewGame(
    userId: string,
    plan: NewGamePlan,
  ): Promise<QuizshowGameResponse> {
    const target: QuizshowQuizTarget = {
      kind: 'new_game',
      ownerUserId: userId,
      isAdultsOnly: plan.isAdultsOnly,
    };
    const { shape } = plan;
    this.quizzes.assertShapeAllowed(target, shape);
    const gameId = await this.dataSource.transaction(
      async (manager: EntityManager) => {
        await manager.query(MEMBER_LOCK_SQL, [
          QUIZSHOW_GAMES_LOCK_PREFIX + userId,
        ]);
        const countRows: { game_count: number }[] = await manager.query(
          GAME_COUNT_SQL,
          [userId],
        );
        if (
          Number(countRows[0]?.game_count ?? 0) >= QUIZSHOW_GAMES_PER_MEMBER_MAX
        ) {
          throw quizshowError('quizshow_game_limit_reached');
        }
        return this.quizzes.writeQuiz(
          {
            target,
            userId,
            shape,
            sourceTemplateId: plan.sourceTemplateId,
            expectedUpdatedAt: undefined,
          },
          manager,
        );
      },
    );
    return this.quizzes.buildGameResponse(gameId);
  }
}
