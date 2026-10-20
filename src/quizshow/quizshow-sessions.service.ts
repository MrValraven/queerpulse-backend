import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, IsNull, QueryFailedError } from 'typeorm';
import type { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { FEATURE_NOT_AVAILABLE_MESSAGE } from '../common/feature.decorator';
import { EventStatus } from '../events/entities/event.entity';
import { QuizshowPlayerRecord } from './entities/quizshow-player.entity';
import { QuizshowQuizRecord } from './entities/quizshow-quiz.entity';
import { QuizshowSessionRecord } from './entities/quizshow-session.entity';
import type { QuizshowJoinDto } from './dto/quizshow-join.dto';
import type { QuizshowOpenGameSessionDto } from './dto/quizshow-game.dto';
import type { QuizshowOpenSessionDto } from './dto/quizshow-open-session.dto';
import { QuizshowAccessService } from './quizshow-access.service';
import { quizshowError, quizshowErrorWithDetails } from './quizshow-errors';
import { QuizshowGuestPushService } from './quizshow-guest-push.service';
import { QuizshowPersistenceService } from './quizshow-persistence.service';
import { isAdultsOnlySession, isQuizshowPlayable } from './quizshow-play-rules';
import {
  completenessProblems,
  hasAdultsRound,
} from './quizshow-quiz-validation';
import { QuizshowQuizService } from './quizshow-quiz.service';
import {
  buildResultsResponse,
  type QuizshowResultSessionRow,
} from './quizshow-results-card';
import { QuizshowRuntimeService } from './quizshow-runtime.service';
import {
  buildSessionSnapshot,
  CRYPTO_RANDOM,
  generateJoinCode,
  type QuizshowSessionSnapshot,
} from './quizshow-snapshot';
import {
  QUIZSHOW_JOIN_CODE_PATTERN,
  QUIZSHOW_LIMITS,
  QUIZSHOW_LOBBY_OPENS_PER_HOUR_MAX,
  QUIZSHOW_OPEN_SESSION_STATUSES,
  type QuizshowJoinResponse,
  type QuizshowResultsResponse,
} from './quizshow.contract';

const JOIN_CODE_ATTEMPTS = 5;
const JOIN_CODE_INDEX = 'UQ_quizshow_sessions_open_join_code';
const OPEN_EVENT_INDEX = 'UQ_quizshow_sessions_open_event';
const OPEN_QUIZ_INDEX = 'UQ_quizshow_sessions_open_quiz';
const MILLISECONDS_PER_HOUR = 3_600_000;
const LOBBY_OPEN_LOCK_PREFIX = 'quizshow_lobby_open:';

/**
 * $1 user id, $2 window start: the lobbies the member opened in the rolling
 * hour, events and games together. Reads the lobby opens ledger, which keeps
 * no key to quizzes or sessions, so a deleted game leaves its opens counted.
 */
export const LOBBY_OPEN_COUNT_SQL = `
  SELECT COUNT(*)::int AS "open_count"
  FROM "quizshow_lobby_opens" "lobby_open"
  WHERE "lobby_open"."user_id" = $1 AND "lobby_open"."opened_at" > $2
`;

/** $1 user id, $2 opened at: records one lobby open in the ledger. */
export const LOBBY_OPEN_INSERT_SQL = `
  INSERT INTO "quizshow_lobby_opens" ("user_id", "opened_at") VALUES ($1, $2)
`;

/** $1 user id, $2 window start: drops the member's opens that left the rolling hour. */
export const LOBBY_OPEN_PRUNE_SQL = `
  DELETE FROM "quizshow_lobby_opens"
  WHERE "user_id" = $1 AND "opened_at" <= $2
`;

/** Uppercases and strips spaces and hyphens; null unless the result is a valid join code. */
export function normaliseJoinCode(raw: string): string | null {
  const code = raw.toUpperCase().replace(/[\s-]/g, '');
  return QUIZSHOW_JOIN_CODE_PATTERN.test(code) ? code : null;
}

function uniqueViolationIndex(error: unknown): string | null {
  if (!(error instanceof QueryFailedError)) return null;
  const driverError = (error as { driverError?: unknown }).driverError as
    { code?: string; constraint?: string } | undefined;
  if (driverError?.code !== '23505') return null;
  return driverError.constraint ?? null;
}

interface KeptSessionRow {
  id: string;
  has_results: boolean;
}

interface OpenSessionRow {
  id: string;
  join_code: string;
}

/** The sessions of one event (`event_id`) or of one game (`quiz_id`). */
interface SessionScopeFilter {
  column: 'event_id' | 'quiz_id';
  id: string;
}

interface OpenForQuizInput {
  quizId: string;
  eventId: string | null;
  userId: string;
  settings: QuizshowOpenSessionDto;
  snapshot: QuizshowSessionSnapshot;
  /** Kept sessions with a results card, deleted in the open transaction. */
  keptSessions: KeptSessionRow[];
  /** Names the scope in logs by id only, such as `event <id>` or `game <id>`. */
  logLabel: string;
}

export interface QuizshowOpenSessionResult {
  sessionId: string;
  joinCode: string;
  isGuestPushSent: boolean;
}

/**
 * Opens lobbies, checks who may join, serves the results card and deletes
 * kept results. The live game itself runs in the runtime service.
 */
@Injectable()
export class QuizshowSessionsService {
  private readonly logger = new Logger(QuizshowSessionsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly access: QuizshowAccessService,
    private readonly quizService: QuizshowQuizService,
    private readonly guestPush: QuizshowGuestPushService,
    private readonly persistence: QuizshowPersistenceService,
    private readonly runtime: QuizshowRuntimeService,
  ) {}

  async openSession(
    slug: string,
    userId: string,
    input: QuizshowOpenSessionDto,
  ): Promise<QuizshowOpenSessionResult> {
    const { event } = await this.access.loadViewableEvent(slug, userId);
    await this.access.assertOrganiser(event, userId);
    await this.access.assertNotCohostPlaying(event.id, userId);
    if (event.status !== EventStatus.Published) {
      throw quizshowError('quizshow_event_not_playable');
    }
    const quiz = await this.quizService.loadQuiz(event.id);
    if (!quiz) throw quizshowError('quizshow_quiz_not_found');
    const problems = completenessProblems(quiz);
    if (problems.length > 0) {
      throw quizshowErrorWithDetails('quizshow_quiz_incomplete', { problems });
    }
    if (hasAdultsRound(quiz) && !this.access.isAdultsEvent(event)) {
      throw quizshowError('quizshow_adults_round_needs_adults_event');
    }
    const eventScope: SessionScopeFilter = {
      column: 'event_id',
      id: event.id,
    };
    await this.assertNoOpenSession(eventScope);
    const sessionsWithResults = await this.sessionsWithResultsToReplace(
      eventScope,
      input,
    );
    const quizRecord = await this.dataSource.manager.findOne(
      QuizshowQuizRecord,
      { where: { eventId: event.id }, select: { id: true } },
    );
    if (!quizRecord) throw quizshowError('quizshow_quiz_not_found');

    const opened = await this.openForQuiz({
      quizId: quizRecord.id,
      eventId: event.id,
      userId,
      settings: input,
      snapshot: buildSessionSnapshot(quiz, CRYPTO_RANDOM),
      keptSessions: sessionsWithResults,
      logLabel: `event ${event.id}`,
    });

    const isGuestPushSent =
      input.notifyGuests === true &&
      (await this.claimGuestPush(event.id, opened.sessionId, opened.startedAt));
    if (isGuestPushSent) {
      void this.guestPush
        .sendLobbyOpened({
          eventId: event.id,
          eventTitle: event.title,
          hostUserId: event.hostId,
          sessionId: opened.sessionId,
          joinCode: opened.joinCode,
          startedAt: opened.startedAt,
        })
        .catch((error: unknown) => {
          this.logger.warn(
            `Live game push failed for session ${opened.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }
    return {
      sessionId: opened.sessionId,
      joinCode: opened.joinCode,
      isGuestPushSent,
    };
  }

  /** Opens a lobby for the caller's own game. A game sends no push. */
  async openGameSession(
    gameId: string,
    userId: string,
    input: QuizshowOpenGameSessionDto,
  ): Promise<QuizshowOpenSessionResult> {
    const game = await this.access.loadOwnedGame(gameId, userId);
    const quiz = await this.quizService.loadQuizById(game.id);
    if (!quiz) throw quizshowError('quizshow_game_not_found');
    const problems = completenessProblems(quiz);
    if (problems.length > 0) {
      throw quizshowErrorWithDetails('quizshow_quiz_incomplete', { problems });
    }
    if (hasAdultsRound(quiz) && !game.isAdultsOnly) {
      throw quizshowError('quizshow_game_adults_rounds_need_switch');
    }
    const gameScope: SessionScopeFilter = { column: 'quiz_id', id: game.id };
    await this.assertNoOpenSession(gameScope);
    const sessionsWithResults = await this.sessionsWithResultsToReplace(
      gameScope,
      input,
    );

    const opened = await this.openForQuiz({
      quizId: game.id,
      eventId: null,
      userId,
      settings: input,
      snapshot: buildSessionSnapshot(quiz, CRYPTO_RANDOM),
      keptSessions: sessionsWithResults,
      logLabel: `game ${game.id}`,
    });
    return {
      sessionId: opened.sessionId,
      joinCode: opened.joinCode,
      isGuestPushSent: false,
    };
  }

  async join(
    user: CurrentUserData,
    input: QuizshowJoinDto,
  ): Promise<QuizshowJoinResponse> {
    if (!isQuizshowPlayable()) {
      throw new NotFoundException(FEATURE_NOT_AVAILABLE_MESSAGE);
    }
    const joinCode = normaliseJoinCode(input.code);
    if (joinCode === null) throw quizshowError('quizshow_join_code_not_found');
    const manager = this.dataSource.manager;
    const session = await manager.findOne(QuizshowSessionRecord, {
      where: { joinCode },
      order: { startedAt: 'DESC' },
    });
    if (!session) throw quizshowError('quizshow_join_code_not_found');

    const now = Date.now();
    let status = session.status;
    let endedAt = session.endedAt;
    if (
      (QUIZSHOW_OPEN_SESSION_STATUSES as readonly string[]).includes(status) &&
      (await this.runtime.abandonIfIdle(session.id, now))
    ) {
      status = 'abandoned';
      endedAt = new Date(now);
    }
    if (status === 'finished' || status === 'abandoned') {
      const memoryMs =
        QUIZSHOW_LIMITS.finishedCodeMemoryHours * MILLISECONDS_PER_HOUR;
      if (endedAt !== null && now - endedAt.getTime() <= memoryMs) {
        throw quizshowError('quizshow_session_finished');
      }
      throw quizshowError('quizshow_join_code_not_found');
    }

    const snapshot = session.quizSnapshot as QuizshowSessionSnapshot;
    const isRestricted = user.restricted === true;
    // A game session has no event; an event session's event row cascades.
    if (session.eventId === null) {
      const game = await manager.findOne(QuizshowQuizRecord, {
        where: { id: session.quizId },
        select: { id: true, ownerUserId: true, isAdultsOnly: true },
      });
      if (!game) throw quizshowError('quizshow_join_code_not_found');
      const scope = await this.access.loadPlayScope({
        kind: 'game',
        eventId: null,
        gameId: game.id,
        hostUserId: game.ownerUserId,
      });
      if (scope === null || scope.kind !== 'game') {
        throw quizshowError('quizshow_join_code_not_found');
      }
      const { existingPlayer } = await this.access.assertMayPlay({
        session,
        scope,
        userId: user.userId,
        isRestricted,
        shouldCheckCapacity: true,
      });
      const host = await this.access.loadJoinHost(scope.ownerUserId);
      if (host === null) throw quizshowError('quizshow_join_code_not_found');
      return {
        sessionId: session.id,
        kind: 'game',
        eventSlug: null,
        eventTitle: null,
        quizTitle: snapshot.title,
        isAdultsOnly: isAdultsOnlySession(game.isAdultsOnly, snapshot),
        host,
        status,
        isRejoin: existingPlayer !== null,
      };
    }

    const scope = await this.access.loadPlayScope({
      kind: 'event',
      eventId: session.eventId,
      gameId: null,
      hostUserId: null,
    });
    if (scope === null || scope.kind !== 'event') {
      throw quizshowError('quizshow_join_code_not_found');
    }
    const { event } = scope;
    const { existingPlayer } = await this.access.assertMayPlay({
      session,
      scope,
      userId: user.userId,
      isRestricted,
      shouldCheckCapacity: true,
    });
    return {
      sessionId: session.id,
      kind: 'event',
      eventSlug: event.slug,
      eventTitle: event.title,
      quizTitle: snapshot.title,
      isAdultsOnly: isAdultsOnlySession(
        this.access.isAdultsEvent(event),
        snapshot,
      ),
      host: null,
      status,
      isRejoin: existingPlayer !== null,
    };
  }

  async getResults(
    slug: string,
    userId: string,
  ): Promise<QuizshowResultsResponse> {
    const { event, isOrganizer } = await this.access.loadViewableEvent(
      slug,
      userId,
    );
    if (!isOrganizer && (await this.access.isBarredFromEvent(event, userId))) {
      throw quizshowError('quizshow_results_not_found');
    }
    const manager = this.dataSource.manager;
    const sessionRow = await this.newestResultSession(manager, {
      column: 'event_id',
      id: event.id,
    });
    if (!sessionRow) throw quizshowError('quizshow_results_not_found');
    const viewerPlayer = await manager.findOne(QuizshowPlayerRecord, {
      where: { sessionId: sessionRow.id, userId, removedAt: IsNull() },
    });
    if (
      !isOrganizer &&
      !viewerPlayer &&
      !(await this.hasGoingRsvp(event.id, userId))
    ) {
      throw quizshowError('quizshow_results_not_found');
    }
    if (isOrganizer) {
      await this.access.assertNotCohostPlaying(event.id, userId);
    }
    return buildResultsResponse(manager, {
      sessionRow,
      viewerUserId: userId,
      isOrganizer,
    });
  }

  /** The owner's results card of their game's newest kept session, with the recap. */
  async getGameResults(
    gameId: string,
    userId: string,
  ): Promise<QuizshowResultsResponse> {
    const game = await this.access.loadOwnedGame(gameId, userId);
    const manager = this.dataSource.manager;
    const sessionRow = await this.newestResultSession(manager, {
      column: 'quiz_id',
      id: game.id,
    });
    if (!sessionRow) throw quizshowError('quizshow_results_not_found');
    return buildResultsResponse(manager, {
      sessionRow,
      viewerUserId: userId,
      isOrganizer: true,
    });
  }

  async deleteResults(slug: string, userId: string): Promise<void> {
    const { event } = await this.access.loadViewableEvent(slug, userId);
    await this.access.assertOrganiser(event, userId);
    await this.deleteSessionsWithResults({ column: 'event_id', id: event.id });
  }

  async deleteGameResults(gameId: string, userId: string): Promise<void> {
    const game = await this.access.loadOwnedGame(gameId, userId);
    await this.deleteSessionsWithResults({ column: 'quiz_id', id: game.id });
  }

  /**
   * Inserts the lobby in one transaction, in this order: the per-member lobby
   * lock, the rolling hour count across events and games, the deletion of
   * the kept results the host agreed to replace, the insert, then the lobby
   * open ledger row and the pruning of the member's opens older than an
   * hour. A refused open therefore never costs the host their results.
   */
  private async openForQuiz(
    input: OpenForQuizInput,
  ): Promise<{ sessionId: string; joinCode: string; startedAt: Date }> {
    const { quizId, eventId, userId, settings, snapshot } = input;
    const now = new Date();
    let created: { sessionId: string; joinCode: string } | null = null;
    for (
      let attempt = 0;
      attempt < JOIN_CODE_ATTEMPTS && created === null;
      attempt += 1
    ) {
      const joinCode = generateJoinCode(CRYPTO_RANDOM);
      try {
        const sessionId = await this.dataSource.transaction(async (manager) => {
          await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
            LOBBY_OPEN_LOCK_PREFIX + userId,
          ]);
          await this.assertUnderLobbyRateLimit(manager, userId, now);
          for (const kept of input.keptSessions) {
            await this.persistence.deleteKeptResults(manager, kept.id);
          }
          const insertion = await manager.insert(QuizshowSessionRecord, {
            quizId,
            eventId,
            status: 'lobby',
            joinCode,
            playMode: settings.playMode,
            maxTeamSize:
              settings.playMode === 'teams'
                ? (settings.maxTeamSize ?? null)
                : null,
            isReviewOn: settings.isReviewOn,
            cursor: {
              phase: 'lobby',
              roundIndex: null,
              questionIndex: null,
              roundCount: snapshot.rounds.length,
              phaseStartedAt: null,
              deadline: null,
              extraTimeDeadline: null,
              pausedRemainingMs: null,
              pausedExtraTimeRemainingMs: null,
              isRestartRecovery: false,
              phaseCounter: 0,
            },
            questionLog: [],
            quizSnapshot: snapshot,
            startedByUserId: userId,
            startedAt: now,
            lastHostCommandAt: now,
            attachedOrganiserUserIds: [],
          });
          const insertedId = (
            insertion.identifiers[0] as { id?: string } | undefined
          )?.id;
          if (!insertedId) {
            throw new InternalServerErrorException(
              'The live game could not be created.',
            );
          }
          await this.recordLobbyOpen(manager, userId, now);
          return insertedId;
        });
        created = { sessionId, joinCode };
      } catch (error) {
        const violatedIndex = uniqueViolationIndex(error);
        if (violatedIndex === JOIN_CODE_INDEX) continue;
        if (violatedIndex === OPEN_EVENT_INDEX && eventId !== null) {
          await this.assertNoOpenSession({ column: 'event_id', id: eventId });
        }
        if (violatedIndex === OPEN_QUIZ_INDEX) {
          await this.assertNoOpenSession({ column: 'quiz_id', id: quizId });
        }
        throw error;
      }
    }
    if (created === null) {
      this.logger.error(
        `No free join code after ${JOIN_CODE_ATTEMPTS} attempts for ${input.logLabel}`,
      );
      throw new InternalServerErrorException(
        'A join code could not be assigned.',
      );
    }
    return { ...created, startedAt: now };
  }

  /**
   * Counts the lobbies the member opened in the last hour, events and games
   * together, from the lobby opens ledger, so the count survives a restart
   * and the deletion of a game with its sessions.
   */
  private async assertUnderLobbyRateLimit(
    manager: EntityManager,
    userId: string,
    now: Date,
  ): Promise<void> {
    const windowStart = new Date(now.getTime() - MILLISECONDS_PER_HOUR);
    const rows: { open_count: number | string }[] = await manager.query(
      LOBBY_OPEN_COUNT_SQL,
      [userId, windowStart],
    );
    const openCount = Number(rows[0]?.open_count ?? 0);
    if (openCount >= QUIZSHOW_LOBBY_OPENS_PER_HOUR_MAX) {
      throw quizshowError('quizshow_lobby_rate_limited');
    }
  }

  /** Records this open in the ledger and drops the member's opens older than the rolling hour. */
  private async recordLobbyOpen(
    manager: EntityManager,
    userId: string,
    now: Date,
  ): Promise<void> {
    await manager.query(LOBBY_OPEN_INSERT_SQL, [userId, now]);
    await manager.query(LOBBY_OPEN_PRUNE_SQL, [
      userId,
      new Date(now.getTime() - MILLISECONDS_PER_HOUR),
    ]);
  }

  /**
   * The kept sessions with a results card, after the host agreed to replace
   * them. A session that ended without a results card (an abandoned lobby)
   * is left to the 30-day retention sweep, so its report window stays open.
   */
  private async sessionsWithResultsToReplace(
    scope: SessionScopeFilter,
    settings: QuizshowOpenSessionDto,
  ): Promise<KeptSessionRow[]> {
    const sessionsWithResults = (
      await this.keptSessions(this.dataSource.manager, scope)
    ).filter((kept) => kept.has_results);
    if (
      sessionsWithResults.length > 0 &&
      settings.shouldReplaceResults !== true
    ) {
      throw quizshowError('quizshow_results_exist');
    }
    return sessionsWithResults;
  }

  /**
   * Only sessions with a results card are deleted here. An abandoned
   * session without one is left to the 30-day retention sweep.
   */
  private async deleteSessionsWithResults(
    scope: SessionScopeFilter,
  ): Promise<void> {
    const sessionsWithResults = (
      await this.keptSessions(this.dataSource.manager, scope)
    ).filter((kept) => kept.has_results);
    if (sessionsWithResults.length === 0) {
      throw quizshowError('quizshow_results_not_found');
    }
    await this.dataSource.transaction(async (manager) => {
      for (const kept of sessionsWithResults) {
        await this.persistence.deleteKeptResults(manager, kept.id);
      }
    });
  }

  private async newestResultSession(
    manager: EntityManager,
    scope: SessionScopeFilter,
  ): Promise<QuizshowResultSessionRow | null> {
    const sessionRows: QuizshowResultSessionRow[] = await manager.query(
      `SELECT "session"."id" AS "id",
              "session"."play_mode" AS "play_mode",
              "session"."started_at" AS "started_at",
              "session"."ended_at" AS "ended_at"
       FROM "quizshow_sessions" "session"
       INNER JOIN "quizshow_results" "result" ON "result"."session_id" = "session"."id"
       WHERE "session"."${scope.column}" = $1
         AND "session"."results_kept" = true
       ORDER BY "session"."ended_at" DESC NULLS LAST
       LIMIT 1`,
      [scope.id],
    );
    return sessionRows[0] ?? null;
  }

  private async assertNoOpenSession(scope: SessionScopeFilter): Promise<void> {
    const rows: OpenSessionRow[] = await this.dataSource.query(
      `SELECT "session"."id" AS "id", "session"."join_code" AS "join_code"
       FROM "quizshow_sessions" "session"
       WHERE "session"."${scope.column}" = $1
         AND "session"."status" IN ('lobby', 'running', 'paused')
       LIMIT 1`,
      [scope.id],
    );
    const open = rows[0];
    if (open) {
      throw quizshowErrorWithDetails('quizshow_session_already_open', {
        sessionId: open.id,
        joinCode: open.join_code,
      });
    }
  }

  /** Ended sessions of the event or game whose players, answers and results are still kept. */
  private async keptSessions(
    manager: EntityManager,
    scope: SessionScopeFilter,
  ): Promise<KeptSessionRow[]> {
    return manager.query(
      `SELECT "session"."id" AS "id",
              EXISTS (
                SELECT 1 FROM "quizshow_results" "result"
                WHERE "result"."session_id" = "session"."id"
              ) AS "has_results"
       FROM "quizshow_sessions" "session"
       WHERE "session"."${scope.column}" = $1
         AND "session"."results_kept" = true
         AND "session"."status" IN ('finished', 'abandoned')
       ORDER BY "session"."started_at" ASC`,
      [scope.id],
    );
  }

  private async hasGoingRsvp(
    eventId: string,
    userId: string,
  ): Promise<boolean> {
    const rows: { has_rsvp: boolean }[] = await this.dataSource.query(
      `SELECT EXISTS (
         SELECT 1 FROM "event_rsvps" "rsvp"
         WHERE "rsvp"."event_id" = $1
           AND "rsvp"."user_id" = $2
           AND "rsvp"."status" = 'going'
       ) AS "has_rsvp"`,
      [eventId, userId],
    );
    return rows[0]?.has_rsvp === true;
  }

  /**
   * Stamps `guest_push_sent_at` on the new session in one statement that
   * finds no other session of the event stamped within the cooldown, so
   * concurrent lobby opens cannot both send. A fault never blocks the lobby.
   */
  private async claimGuestPush(
    eventId: string,
    sessionId: string,
    now: Date,
  ): Promise<boolean> {
    const cooldownStart = new Date(
      now.getTime() - QUIZSHOW_LIMITS.guestPushCooldownMs,
    );
    try {
      const rows: { id: string }[] = await this.dataSource.query(
        `WITH "claimed" AS (
           UPDATE "quizshow_sessions" "session"
           SET "guest_push_sent_at" = $2
           WHERE "session"."id" = $1
             AND NOT EXISTS (
               SELECT 1 FROM "quizshow_sessions" "other"
               WHERE "other"."event_id" = $3
                 AND "other"."id" <> $1
                 AND "other"."guest_push_sent_at" > $4)
           RETURNING "session"."id" AS "id"
         )
         SELECT "id" FROM "claimed"`,
        [sessionId, now, eventId, cooldownStart],
      );
      return rows.length > 0;
    } catch (error) {
      this.logger.warn(
        `Live game push claim failed for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}
