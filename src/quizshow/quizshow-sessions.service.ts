import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import {
  DataSource,
  EntityManager,
  In,
  IsNull,
  QueryFailedError,
} from 'typeorm';
import type { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { Event, EventStatus } from '../events/entities/event.entity';
import { QuizshowPlayerRecord } from './entities/quizshow-player.entity';
import { QuizshowQuizRecord } from './entities/quizshow-quiz.entity';
import { QuizshowResultRecord } from './entities/quizshow-result.entity';
import { QuizshowSessionRecord } from './entities/quizshow-session.entity';
import { QuizshowTeamRecord } from './entities/quizshow-team.entity';
import type { QuizshowJoinDto } from './dto/quizshow-join.dto';
import type { QuizshowOpenSessionDto } from './dto/quizshow-open-session.dto';
import { QuizshowAccessService } from './quizshow-access.service';
import { quizshowError, quizshowErrorWithDetails } from './quizshow-errors';
import { QuizshowGuestPushService } from './quizshow-guest-push.service';
import { QuizshowPersistenceService } from './quizshow-persistence.service';
import {
  completenessProblems,
  hasAdultsRound,
} from './quizshow-quiz-validation';
import { QuizshowQuizService } from './quizshow-quiz.service';
import { QuizshowRuntimeService } from './quizshow-runtime.service';
import {
  buildSessionSnapshot,
  CRYPTO_RANDOM,
  generateJoinCode,
} from './quizshow-snapshot';
import {
  QUIZSHOW_JOIN_CODE_PATTERN,
  QUIZSHOW_LIMITS,
  QUIZSHOW_OPEN_SESSION_STATUSES,
  type QuizshowJoinResponse,
  type QuizshowResultsPodiumEntry,
  type QuizshowResultsResponse,
} from './quizshow.contract';

const JOIN_CODE_ATTEMPTS = 5;
const JOIN_CODE_INDEX = 'UQ_quizshow_sessions_open_join_code';
const OPEN_EVENT_INDEX = 'UQ_quizshow_sessions_open_event';
const MILLISECONDS_PER_HOUR = 3_600_000;

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

interface ResultSessionRow {
  id: string;
  play_mode: 'solo' | 'teams';
  started_at: Date;
  ended_at: Date | null;
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
  ): Promise<{
    sessionId: string;
    joinCode: string;
    isGuestPushSent: boolean;
  }> {
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
    await this.assertNoOpenSession(event.id);
    // A session that ended without a results card (an abandoned lobby) is
    // left to the 30-day retention sweep, so its report window stays open.
    const sessionsWithResults = (
      await this.keptSessions(this.dataSource.manager, event.id)
    ).filter((kept) => kept.has_results);
    const hasKeptResults = sessionsWithResults.length > 0;
    if (hasKeptResults && input.shouldReplaceResults !== true) {
      throw quizshowError('quizshow_results_exist');
    }

    const now = new Date();
    const snapshot = buildSessionSnapshot(quiz, CRYPTO_RANDOM);
    let created: { sessionId: string; joinCode: string } | null = null;
    for (
      let attempt = 0;
      attempt < JOIN_CODE_ATTEMPTS && created === null;
      attempt += 1
    ) {
      const joinCode = generateJoinCode(CRYPTO_RANDOM);
      try {
        const sessionId = await this.dataSource.transaction(async (manager) => {
          for (const kept of sessionsWithResults) {
            await this.persistence.deleteKeptResults(manager, kept.id);
          }
          const quizRecord = await manager.findOne(QuizshowQuizRecord, {
            where: { eventId: event.id },
          });
          if (!quizRecord) throw quizshowError('quizshow_quiz_not_found');
          const insertion = await manager.insert(QuizshowSessionRecord, {
            quizId: quizRecord.id,
            eventId: event.id,
            status: 'lobby',
            joinCode,
            playMode: input.playMode,
            maxTeamSize:
              input.playMode === 'teams' ? (input.maxTeamSize ?? null) : null,
            isReviewOn: input.isReviewOn,
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
          return insertedId;
        });
        created = { sessionId, joinCode };
      } catch (error) {
        const violatedIndex = uniqueViolationIndex(error);
        if (violatedIndex === JOIN_CODE_INDEX) continue;
        if (violatedIndex === OPEN_EVENT_INDEX) {
          await this.assertNoOpenSession(event.id);
        }
        throw error;
      }
    }
    if (created === null) {
      this.logger.error(
        `No free join code after ${JOIN_CODE_ATTEMPTS} attempts for event ${event.id}`,
      );
      throw new InternalServerErrorException(
        'A join code could not be assigned.',
      );
    }

    const { sessionId: createdSessionId, joinCode: createdJoinCode } = created;
    const isGuestPushSent =
      input.notifyGuests === true &&
      (await this.claimGuestPush(event.id, createdSessionId, now));
    if (isGuestPushSent) {
      void this.guestPush
        .sendLobbyOpened({
          eventId: event.id,
          eventTitle: event.title,
          hostUserId: event.hostId,
          sessionId: createdSessionId,
          joinCode: createdJoinCode,
          startedAt: now,
        })
        .catch((error: unknown) => {
          this.logger.warn(
            `Live game push failed for session ${createdSessionId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }
    return {
      sessionId: createdSessionId,
      joinCode: createdJoinCode,
      isGuestPushSent,
    };
  }

  async join(
    user: CurrentUserData,
    input: QuizshowJoinDto,
  ): Promise<QuizshowJoinResponse> {
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

    const event = await manager.findOne(Event, {
      where: { id: session.eventId },
    });
    if (!event) throw quizshowError('quizshow_join_code_not_found');
    const { existingPlayer } = await this.access.assertMayPlay({
      session,
      event,
      userId: user.userId,
      isRestricted: user.restricted === true,
      shouldCheckCapacity: true,
    });
    return {
      sessionId: session.id,
      eventSlug: event.slug,
      eventTitle: event.title,
      status: status,
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
    const sessionRows: ResultSessionRow[] = await manager.query(
      `SELECT "session"."id" AS "id",
              "session"."play_mode" AS "play_mode",
              "session"."started_at" AS "started_at",
              "session"."ended_at" AS "ended_at"
       FROM "quizshow_sessions" "session"
       INNER JOIN "quizshow_results" "result" ON "result"."session_id" = "session"."id"
       WHERE "session"."event_id" = $1
         AND "session"."results_kept" = true
       ORDER BY "session"."ended_at" DESC NULLS LAST
       LIMIT 1`,
      [event.id],
    );
    const sessionRow = sessionRows[0];
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
    const result = await manager.findOne(QuizshowResultRecord, {
      where: { sessionId: sessionRow.id },
    });
    if (!result) throw quizshowError('quizshow_results_not_found');

    const playerIds = result.podium
      .filter((entry) => entry.kind === 'player')
      .map((entry) => entry.entrantId);
    const teamIds = result.podium
      .filter((entry) => entry.kind === 'team')
      .map((entry) => entry.entrantId);
    if (viewerPlayer?.teamId) teamIds.push(viewerPlayer.teamId);
    const podiumPlayers =
      playerIds.length === 0
        ? []
        : await manager.find(QuizshowPlayerRecord, {
            where: { id: In(playerIds) },
          });
    const teams =
      teamIds.length === 0
        ? []
        : await manager.find(QuizshowTeamRecord, {
            where: { id: In(teamIds) },
          });

    const podium: QuizshowResultsPodiumEntry[] = [];
    for (const entry of result.podium) {
      if (entry.kind === 'player') {
        const player = podiumPlayers.find((row) => row.id === entry.entrantId);
        if (!player) continue;
        podium.push({
          place: entry.place,
          kind: 'player',
          name: player.screenName,
          colorKey: null,
          score: entry.score,
          isMine: viewerPlayer?.id === player.id,
        });
      } else {
        const team = teams.find((row) => row.id === entry.entrantId);
        if (!team) continue;
        podium.push({
          place: entry.place,
          kind: 'team',
          name: team.name,
          colorKey: team.colorKey,
          score: entry.score,
          isMine: viewerPlayer?.teamId === team.id,
        });
      }
    }
    podium.sort(
      (left, right) =>
        left.place - right.place || left.name.localeCompare(right.name),
    );

    const isTeamsPlay = sessionRow.play_mode === 'teams';
    const viewerTeam = viewerPlayer?.teamId
      ? (teams.find((row) => row.id === viewerPlayer.teamId) ?? null)
      : null;
    const viewerPlace = viewerPlayer
      ? result.placings[viewerPlayer.id]
      : undefined;
    const me =
      viewerPlayer && viewerPlace !== undefined
        ? {
            place: viewerPlace,
            score:
              isTeamsPlay && viewerTeam ? viewerTeam.score : viewerPlayer.score,
            teamName: viewerTeam?.name ?? null,
            teamColorKey: viewerTeam?.colorKey ?? null,
          }
        : null;

    const playerCount = await manager.count(QuizshowPlayerRecord, {
      where: { sessionId: sessionRow.id, removedAt: IsNull() },
    });
    const teamCount = isTeamsPlay
      ? await manager.count(QuizshowTeamRecord, {
          where: { sessionId: sessionRow.id },
        })
      : null;

    return {
      sessionId: sessionRow.id,
      playMode: sessionRow.play_mode,
      startedAt: new Date(sessionRow.started_at).toISOString(),
      endedAt: new Date(
        sessionRow.ended_at ?? sessionRow.started_at,
      ).toISOString(),
      podium,
      me,
      playerCount,
      teamCount,
      recap: isOrganizer ? result.questionStats : null,
    };
  }

  async deleteResults(slug: string, userId: string): Promise<void> {
    const { event } = await this.access.loadViewableEvent(slug, userId);
    await this.access.assertOrganiser(event, userId);
    // Only sessions with a results card are deleted here. An abandoned
    // session without one is left to the 30-day retention sweep.
    const sessionsWithResults = (
      await this.keptSessions(this.dataSource.manager, event.id)
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

  private async assertNoOpenSession(eventId: string): Promise<void> {
    const rows: OpenSessionRow[] = await this.dataSource.query(
      `SELECT "session"."id" AS "id", "session"."join_code" AS "join_code"
       FROM "quizshow_sessions" "session"
       WHERE "session"."event_id" = $1
         AND "session"."status" IN ('lobby', 'running', 'paused')
       LIMIT 1`,
      [eventId],
    );
    const open = rows[0];
    if (open) {
      throw quizshowErrorWithDetails('quizshow_session_already_open', {
        sessionId: open.id,
        joinCode: open.join_code,
      });
    }
  }

  /** Ended sessions of the event whose players, answers and results are still kept. */
  private async keptSessions(
    manager: EntityManager,
    eventId: string,
  ): Promise<KeptSessionRow[]> {
    return manager.query(
      `SELECT "session"."id" AS "id",
              EXISTS (
                SELECT 1 FROM "quizshow_results" "result"
                WHERE "result"."session_id" = "session"."id"
              ) AS "has_results"
       FROM "quizshow_sessions" "session"
       WHERE "session"."event_id" = $1
         AND "session"."results_kept" = true
         AND "session"."status" IN ('finished', 'abandoned')
       ORDER BY "session"."started_at" ASC`,
      [eventId],
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
