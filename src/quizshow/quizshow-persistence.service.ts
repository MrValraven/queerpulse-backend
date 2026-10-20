import { Injectable, Logger } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { toVisibleAvatarUrl } from '../common/member-ref';
import type { QuizshowStoredPodiumEntry } from './entities/quizshow-result.entity';
import type { QuizshowStoredCursor } from './entities/quizshow-session.entity';
import {
  QUIZSHOW_LIMITS,
  type QuizshowAnswerPayload,
  type QuizshowCursor,
  type QuizshowLanguage,
  type QuizshowNextEvent,
  type QuizshowPhase,
  type QuizshowPlayMode,
  type QuizshowPodiumEntry,
  type QuizshowRecap,
  type QuizshowRecapQuestion,
  type QuizshowScoresScope,
  type QuizshowSessionStatus,
  type QuizshowTeamColorKey,
  type QuizshowText,
} from './quizshow.contract';
import { entrantTotals, isJokerActiveFor } from './quizshow-engine-state';
import type {
  QuizshowLiveAnswer,
  QuizshowLivePlayer,
  QuizshowLiveQuestionPlay,
  QuizshowLiveState,
  QuizshowLiveTeam,
  QuizshowLiveVote,
  QuizshowLiveVoteOption,
  QuizshowPersistOperation,
  QuizshowQuestionLogEntry,
} from './quizshow-engine-types';
import { isAdultsOnlySession } from './quizshow-play-rules';
import { isPartyRoundKind } from './quizshow-quiz-validation';
import {
  competitionRanks,
  streakBonusFor,
  teamQuestionPoints,
} from './quizshow-scoring';
import {
  snapshotQuestionAt,
  type QuizshowRandom,
  type QuizshowSessionSnapshot,
  type QuizshowSnapshotQuestion,
  type QuizshowSnapshotRound,
} from './quizshow-snapshot';

/** Phases a restart replays from the question's first phase; every other phase resumes as checkpointed. */
export const QUIZSHOW_RESTART_REPLAY_PHASES: readonly QuizshowPhase[] = [
  'read',
  'open',
  'write',
  'review',
  'vote',
];

const OPEN_STATUSES_SQL = `('lobby', 'running', 'paused')`;

const SCORES_SCOPE_BY_PHASE: Partial<
  Record<QuizshowPhase, QuizshowScoresScope>
> = { scores: 'question', leaderboard: 'round', podium: 'final' };

const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;
const ERROR_NAME_PATTERN = /^[A-Za-z]{1,64}$/;

interface SqlStatement {
  sql: string;
  params: unknown[];
}

interface SessionRow {
  id: string;
  quiz_id: string;
  /** Null for a game session. */
  event_id: string | null;
  status: QuizshowSessionStatus;
  join_code: string;
  play_mode: QuizshowPlayMode;
  max_team_size: number | null;
  is_review_on: boolean;
  cursor: QuizshowStoredCursor;
  question_log: QuizshowQuestionLogEntry[] | null;
  quiz_snapshot: QuizshowSessionSnapshot;
  started_by_user_id: string | null;
  last_host_command_at: Date | string;
  paused_at: Date | string | null;
  attached_organiser_user_ids: string[] | null;
  quiz_owner_user_id: string | null;
  quiz_is_adults_only: boolean;
  /** The event columns read null for a game session (left join). */
  event_slug: string | null;
  event_title: string | null;
  event_host_id: string | null;
  event_series_id: string | null;
  event_series_index: number | null;
  event_is_adults_only: boolean | null;
}

interface PlayerRow {
  id: string;
  user_id: string;
  is_cohost_player: boolean;
  team_id: string | null;
  screen_name: string;
  is_avatar_shown: boolean;
  has_extra_time: boolean;
  score: number;
  streak: number;
  has_used_joker: boolean;
  joker_round_index: number | null;
  removed_at: Date | string | null;
  joined_at: Date | string;
  profile_avatar_url: string | null;
  profile_photo_visible: boolean | null;
}

interface TeamRow {
  id: string;
  name: string;
  color_key: QuizshowTeamColorKey;
  score: number;
  has_used_joker: boolean;
  joker_round_index: number | null;
  created_at: Date | string;
}

interface AnswerRow {
  id: string;
  player_id: string;
  question_id: string;
  payload: QuizshowAnswerPayload;
  received_at: Date | string;
  elapsed_ms: number | null;
  is_correct: boolean | null;
  points_awarded: number;
  vote_option_id: string | null;
  hidden_at: Date | string | null;
}

interface VoteRow {
  voter_player_id: string;
  question_id: string;
  answer_id: string | null;
  created_at: Date | string;
}

interface NextEventRow {
  slug: string;
  title: string;
  start_at: Date | string;
}

interface QuestionAggregateRow {
  question_id: string;
  answer_count: number;
  correct_count: number;
  average_elapsed_ms: number | null;
}

interface IdRow {
  id: string;
}

interface WriteChain {
  tail: Promise<void>;
  token: symbol;
}

/** The data source or the manager of an open transaction: both run raw SQL. */
type QuizshowQueryTarget = Pick<EntityManager, 'query'>;

/** One operation's write, built at enqueue time and run on the target it is handed. */
interface PreparedWrite {
  /** True when its statements must commit together even on their own. */
  isTransaction: boolean;
  /** True when it has nothing to run (no field changed, a skipped checkpoint). */
  isEmpty: boolean;
  run: (queryTarget: QuizshowQueryTarget) => Promise<void>;
}

/** What the recap needs of one logged question, read from the frozen snapshot at enqueue time. */
interface RecapSource {
  entry: QuizshowQuestionLogEntry;
  prompt: QuizshowText;
}

function toEpochMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function toEpochMsOrNull(value: Date | string | null): number | null {
  return value === null ? null : toEpochMs(value);
}

function toDateOrNull(epochMs: number | null): Date | null {
  return epochMs === null ? null : new Date(epochMs);
}

/** The engine clock of the ending: the `ended` cursor's start, else the time of the enqueue. */
function endedAtOf(state: Pick<QuizshowLiveState, 'cursor'>): Date {
  const { phase, phaseStartedAt } = state.cursor;
  return new Date(
    phase === 'ended' && phaseStartedAt !== null ? phaseStartedAt : Date.now(),
  );
}

/** A SQLSTATE when the driver gave one, else the error's class name; never the error text. */
export function quizshowWriteFailureCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'unknown';
  const candidate = error as {
    code?: unknown;
    driverError?: { code?: unknown } | null;
    name?: unknown;
  };
  for (const code of [candidate.code, candidate.driverError?.code]) {
    if (typeof code === 'string' && SQLSTATE_PATTERN.test(code)) return code;
  }
  if (
    typeof candidate.name === 'string' &&
    ERROR_NAME_PATTERN.test(candidate.name)
  ) {
    return candidate.name;
  }
  return 'unknown';
}

/** The cursor as the `cursor` column stores it: no status, the phase counter for the phase id. */
export function toStoredCursor(
  state: Pick<QuizshowLiveState, 'cursor' | 'phaseCounter'>,
): QuizshowStoredCursor {
  const cursor = state.cursor;
  return {
    phase: cursor.phase,
    roundIndex: cursor.roundIndex,
    questionIndex: cursor.questionIndex,
    roundCount: cursor.roundCount,
    phaseStartedAt: cursor.phaseStartedAt,
    deadline: cursor.deadline,
    extraTimeDeadline: cursor.extraTimeDeadline,
    pausedRemainingMs: cursor.pausedRemainingMs,
    pausedExtraTimeRemainingMs: cursor.pausedExtraTimeRemainingMs,
    isRestartRecovery: cursor.isRestartRecovery,
    phaseCounter: state.phaseCounter,
  };
}

/**
 * The recap stored with the results: per logged question the answer count,
 * the share of eligible players with a full-base answer and the mean answer
 * time. Party questions, skipped questions and questions nobody was eligible
 * for carry null for both numbers. A question that never reached its reveal
 * (the game ended mid-question) counts as skipped.
 */
export function buildQuizshowRecap(
  sources: readonly RecapSource[],
  aggregateRows: readonly QuestionAggregateRow[],
): QuizshowRecap {
  const aggregateByQuestion = new Map(
    aggregateRows.map((row) => [row.question_id, row]),
  );
  const isSkippedEntry = (entry: QuizshowQuestionLogEntry): boolean =>
    entry.wasSkipped || entry.revealedAt === null;
  const questions = sources.map(({ entry, prompt }): QuizshowRecapQuestion => {
    const wasSkipped = isSkippedEntry(entry);
    const aggregate = aggregateByQuestion.get(entry.questionId);
    const answerCount = Number(aggregate?.answer_count ?? 0);
    const correctCount = Number(aggregate?.correct_count ?? 0);
    const averageElapsedMs =
      aggregate?.average_elapsed_ms === null ||
      aggregate?.average_elapsed_ms === undefined
        ? null
        : Number(aggregate.average_elapsed_ms);
    const isMeasured =
      !isPartyRoundKind(entry.roundKind) &&
      !wasSkipped &&
      entry.eligibleCount > 0;
    return {
      roundIndex: entry.roundIndex,
      questionIndex: entry.questionIndex,
      roundKind: entry.roundKind,
      type: entry.type,
      prompt,
      answerCount,
      percentCorrect: isMeasured
        ? Math.round((100 * correctCount) / entry.eligibleCount)
        : null,
      averageAnswerMs:
        isMeasured && averageElapsedMs !== null
          ? Math.round(averageElapsedMs)
          : null,
      wasSkipped,
    };
  });
  return {
    questionsPlayed: sources.filter(({ entry }) => !isSkippedEntry(entry))
      .length,
    answersGiven: questions.reduce(
      (total, question) => total + question.answerCount,
      0,
    ),
    questions,
  };
}

function truthText(
  truth: QuizshowText | undefined,
  screenLanguage: QuizshowLanguage,
): string {
  if (truth === undefined) return '';
  return truth[screenLanguage] || truth.en || truth.pt;
}

function correctPositionsOf(
  question: QuizshowSnapshotQuestion,
  payload: QuizshowAnswerPayload,
): number | null {
  if (
    question.type !== 'order' ||
    question.answer === null ||
    payload.type !== 'order'
  ) {
    return null;
  }
  return question.answer.orderedIds.filter(
    (optionId, position) => payload.orderedIds[position] === optionId,
  ).length;
}

/**
 * The phase id answers of the reloaded question were taken in, worked back
 * from the cursor: `open` sits one phase before `reveal` on a quiz question;
 * `write` sits before `reveal`, an optional `review` and an optional `vote`
 * on a party question.
 */
function answeringPhaseId(
  state: QuizshowLiveState,
  round: QuizshowSnapshotRound,
  answerRows: readonly AnswerRow[],
): string {
  const revealPhaseCounter =
    state.cursor.phase === 'scores'
      ? state.phaseCounter - 1
      : state.phaseCounter;
  if (!isPartyRoundKind(round.kind)) return String(revealPhaseCounter - 1);
  const optionCount =
    answerRows.filter((row) => row.vote_option_id !== null).length +
    (round.kind === 'lie_detector' ? 1 : 0);
  const hasVote = optionCount >= 2;
  const hasReview = state.isReviewOn && answerRows.length > 0;
  return String(
    revealPhaseCounter - 1 - (hasVote ? 1 : 0) - (hasReview ? 1 : 0),
  );
}

/**
 * Pulse Live (`quizshow`) persistence: the ordered write queue each live
 * session's engine operations go through, the boot recovery, the rebuild of a
 * live state from its rows, and the abandonment and results deletion reads and
 * writes. A failed write logs its operation type, the session id and a code;
 * payloads, answer text, screen names, team names and error messages stay out
 * of the log.
 */
@Injectable()
export class QuizshowPersistenceService {
  private readonly logger = new Logger(QuizshowPersistenceService.name);
  private readonly writeChains = new Map<string, WriteChain>();

  constructor(private readonly dataSource: DataSource) {}

  /** The live state of a lobby, running or paused session; null for any other status or an unknown id. */
  async loadLiveState(
    sessionId: string,
    random: QuizshowRandom,
  ): Promise<QuizshowLiveState | null> {
    const sessionRows: SessionRow[] = await this.dataSource.query(
      `SELECT "session"."id" AS "id",
              "session"."quiz_id" AS "quiz_id",
              "session"."event_id" AS "event_id",
              "session"."status" AS "status",
              "session"."join_code" AS "join_code",
              "session"."play_mode" AS "play_mode",
              "session"."max_team_size" AS "max_team_size",
              "session"."is_review_on" AS "is_review_on",
              "session"."cursor" AS "cursor",
              "session"."question_log" AS "question_log",
              "session"."quiz_snapshot" AS "quiz_snapshot",
              "session"."started_by_user_id" AS "started_by_user_id",
              "session"."last_host_command_at" AS "last_host_command_at",
              "session"."paused_at" AS "paused_at",
              to_jsonb("session"."attached_organiser_user_ids") AS "attached_organiser_user_ids",
              "quiz"."owner_user_id" AS "quiz_owner_user_id",
              "quiz"."is_adults_only" AS "quiz_is_adults_only",
              "event"."slug" AS "event_slug",
              "event"."title" AS "event_title",
              "event"."host_id" AS "event_host_id",
              "event"."series_id" AS "event_series_id",
              "event"."series_index" AS "event_series_index",
              ("event"."format_details" ->> 'isAdultsOnly') = 'true' AS "event_is_adults_only"
       FROM "quizshow_sessions" "session"
       INNER JOIN "quizshow_quizzes" "quiz" ON "quiz"."id" = "session"."quiz_id"
       LEFT JOIN "events" "event" ON "event"."id" = "session"."event_id"
       WHERE "session"."id" = $1
         AND "session"."status" IN ${OPEN_STATUSES_SQL}`,
      [sessionId],
    );
    const sessionRow = sessionRows[0];
    if (sessionRow === undefined) return null;
    // A game session has no event row; an event session whose event row is
    // gone loads as null, as it did with the inner join.
    const isGameSession = sessionRow.event_id === null;
    if (!isGameSession && sessionRow.event_slug === null) return null;

    const [playerRows, teamRows, nextEvent] = await Promise.all([
      this.dataSource.query<PlayerRow[]>(
        `SELECT "player"."id" AS "id",
                "player"."user_id" AS "user_id",
                "player"."is_cohost_player" AS "is_cohost_player",
                "player"."team_id" AS "team_id",
                "player"."screen_name" AS "screen_name",
                "player"."is_avatar_shown" AS "is_avatar_shown",
                "player"."has_extra_time" AS "has_extra_time",
                "player"."score" AS "score",
                "player"."streak" AS "streak",
                "player"."has_used_joker" AS "has_used_joker",
                "player"."joker_round_index" AS "joker_round_index",
                "player"."removed_at" AS "removed_at",
                "player"."joined_at" AS "joined_at",
                "profile"."avatar_url" AS "profile_avatar_url",
                "profile"."photo_visible" AS "profile_photo_visible"
         FROM "quizshow_players" "player"
         LEFT JOIN "profiles" "profile" ON "profile"."user_id" = "player"."user_id"
         WHERE "player"."session_id" = $1
         ORDER BY "player"."joined_at" ASC, "player"."id" ASC`,
        [sessionId],
      ),
      this.dataSource.query<TeamRow[]>(
        `SELECT "team"."id" AS "id",
                "team"."name" AS "name",
                "team"."color_key" AS "color_key",
                "team"."score" AS "score",
                "team"."has_used_joker" AS "has_used_joker",
                "team"."joker_round_index" AS "joker_round_index",
                "team"."created_at" AS "created_at"
         FROM "quizshow_teams" "team"
         WHERE "team"."session_id" = $1
         ORDER BY "team"."created_at" ASC, "team"."id" ASC`,
        [sessionId],
      ),
      isGameSession
        ? Promise.resolve(null)
        : this.loadNextEvent(
            sessionRow.event_series_id,
            sessionRow.event_series_index,
          ),
    ]);

    const snapshot = sessionRow.quiz_snapshot;
    const storedCursor = sessionRow.cursor;
    const phaseCounter = Number(storedCursor.phaseCounter ?? 0);
    const cursor: QuizshowCursor = {
      phaseId: String(phaseCounter),
      status: sessionRow.status,
      phase: storedCursor.phase,
      roundIndex: storedCursor.roundIndex ?? null,
      questionIndex: storedCursor.questionIndex ?? null,
      roundCount: storedCursor.roundCount ?? snapshot.rounds.length,
      phaseStartedAt: storedCursor.phaseStartedAt ?? null,
      deadline: storedCursor.deadline ?? null,
      extraTimeDeadline: storedCursor.extraTimeDeadline ?? null,
      pausedRemainingMs: storedCursor.pausedRemainingMs ?? null,
      pausedExtraTimeRemainingMs:
        storedCursor.pausedExtraTimeRemainingMs ?? null,
      isRestartRecovery: storedCursor.isRestartRecovery === true,
    };
    // An open session is only ever loaded after the process lost it, so a
    // pause taken in a question phase lost that question's play too: the
    // resume replays it, as the boot recovery marks running sessions.
    if (
      cursor.status === 'paused' &&
      QUIZSHOW_RESTART_REPLAY_PHASES.includes(cursor.phase)
    ) {
      cursor.isRestartRecovery = true;
    }
    // A running row in a question phase (a failed boot recovery, or another
    // process checkpointing it back to running) lost its play the same way:
    // it comes back paused for the replay, exactly as the boot recovery
    // leaves it, and the row is written to match.
    const isRunningInReplayPhase =
      cursor.status === 'running' &&
      QUIZSHOW_RESTART_REPLAY_PHASES.includes(cursor.phase);
    let pausedAt = toEpochMsOrNull(sessionRow.paused_at);
    if (isRunningInReplayPhase) {
      cursor.status = 'paused';
      cursor.deadline = null;
      cursor.extraTimeDeadline = null;
      cursor.pausedRemainingMs = null;
      cursor.pausedExtraTimeRemainingMs = null;
      cursor.isRestartRecovery = true;
      pausedAt = Date.now();
    }

    const players = new Map<string, QuizshowLivePlayer>();
    for (const row of playerRows) {
      players.set(row.id, {
        playerId: row.id,
        userId: row.user_id,
        screenName: row.screen_name,
        teamId: row.team_id,
        isCohostPlayer: row.is_cohost_player,
        isAvatarShown: row.is_avatar_shown,
        avatarUrl:
          row.profile_photo_visible === null
            ? null
            : toVisibleAvatarUrl({
                avatarUrl: row.profile_avatar_url,
                photoVisible: row.profile_photo_visible,
              }),
        hasExtraTime: row.has_extra_time,
        score: Number(row.score),
        streak: Number(row.streak),
        hasUsedJoker: row.has_used_joker,
        jokerRoundIndex: row.joker_round_index,
        joinedAt: toEpochMs(row.joined_at),
        removedAt: toEpochMsOrNull(row.removed_at),
        connectedSocketCount: 0,
      });
    }
    const teams = new Map<string, QuizshowLiveTeam>();
    for (const row of teamRows) {
      teams.set(row.id, {
        teamId: row.id,
        name: row.name,
        colorKey: row.color_key,
        score: Number(row.score),
        hasUsedJoker: row.has_used_joker,
        jokerRoundIndex: row.joker_round_index,
        createdAt: toEpochMs(row.created_at),
      });
    }
    const questionLog = sessionRow.question_log ?? [];

    const isScopeAdultsOnly = isGameSession
      ? sessionRow.quiz_is_adults_only === true
      : sessionRow.event_is_adults_only === true;

    const state: QuizshowLiveState = {
      sessionId: sessionRow.id,
      eventId: sessionRow.event_id,
      eventSlug: isGameSession ? null : sessionRow.event_slug,
      eventTitle: isGameSession ? null : sessionRow.event_title,
      kind: isGameSession ? 'game' : 'event',
      gameId: isGameSession ? sessionRow.quiz_id : null,
      isAdultsOnly: isAdultsOnlySession(isScopeAdultsOnly, snapshot),
      hostUserId: isGameSession
        ? sessionRow.quiz_owner_user_id
        : sessionRow.event_host_id,
      openedByUserId: sessionRow.started_by_user_id,
      joinCode: sessionRow.join_code,
      playMode: sessionRow.play_mode,
      maxTeamSize: sessionRow.max_team_size,
      isReviewOn: sessionRow.is_review_on,
      snapshot,
      status: cursor.status,
      cursor,
      phaseCounter,
      pausedAt,
      lastHostCommandAt: toEpochMs(sessionRow.last_host_command_at),
      lastTransition: null,
      players,
      teams,
      current: null,
      questionLog,
      scoresAtLastFrame: new Map(),
      lastScoresFrame: null,
      podium: null,
      attachedOrganiserUserIds: new Set(
        sessionRow.attached_organiser_user_ids ?? [],
      ),
      nextEvent,
      hasScoredQuestion: questionLog.some(
        (entry) => entry.revealedAt !== null && !entry.wasSkipped,
      ),
      isScreenMuted: false,
    };

    const totals = entrantTotals(state);
    state.scoresAtLastFrame = new Map(
      totals.map((total) => [total.entrantId, total.score]),
    );
    const scope = SCORES_SCOPE_BY_PHASE[cursor.phase];
    if (scope !== undefined) {
      state.lastScoresFrame = {
        phaseId: cursor.phaseId,
        scope,
        previousByEntrant: new Map(state.scoresAtLastFrame),
      };
    }
    if (cursor.phase === 'podium') {
      state.podium = competitionRanks(totals)
        .filter((entry) => entry.rank <= 3)
        .map((entry): QuizshowPodiumEntry => ({
          place: entry.rank as 1 | 2 | 3,
          kind: entry.kind,
          entrantId: entry.entrantId,
          name: entry.name,
          colorKey: entry.colorKey,
          score: entry.score,
        }));
    }
    state.current = await this.loadQuestionPlay(state, random);
    // In reveal and scores the stored totals already hold this question's
    // points; the scores frame counts up from the totals before it. In reveal
    // that base waits for the next scores frame; in scores the frame being
    // shown re-sends with it.
    if (
      (cursor.phase === 'reveal' || cursor.phase === 'scores') &&
      state.current !== null
    ) {
      const questionPoints =
        state.playMode === 'teams'
          ? state.current.teamPoints
          : state.current.pointsByPlayer;
      const scoresBeforeQuestion = new Map(state.scoresAtLastFrame);
      for (const [entrantId, points] of questionPoints) {
        const totalScore = scoresBeforeQuestion.get(entrantId);
        if (totalScore !== undefined) {
          scoresBeforeQuestion.set(entrantId, totalScore - points);
        }
      }
      if (cursor.phase === 'reveal') {
        state.scoresAtLastFrame = scoresBeforeQuestion;
      } else if (state.lastScoresFrame !== null) {
        state.lastScoresFrame.previousByEntrant = scoresBeforeQuestion;
      }
    }
    if (isRunningInReplayPhase) this.enqueue(state, { type: 'checkpoint' });
    return state;
  }

  /** Queues one engine operation behind the session's earlier writes; values are read from `state` now. */
  enqueue(state: QuizshowLiveState, operation: QuizshowPersistOperation): void {
    this.enqueueBatch(state, [operation]);
  }

  /**
   * Queues the operations of one command as one write behind the session's
   * earlier writes: they commit in one transaction together, or none of them
   * lands. Values are read from `state` now; an operation that cannot be
   * built drops the whole batch.
   */
  enqueueBatch(
    state: QuizshowLiveState,
    operations: readonly QuizshowPersistOperation[],
  ): void {
    if (operations.length === 0) return;
    const sessionId = state.sessionId;
    const writes: PreparedWrite[] = [];
    for (const operation of operations) {
      try {
        writes.push(this.prepareWrite(state, operation));
      } catch (error: unknown) {
        this.logWriteFailure(operation.type, sessionId, error);
        return;
      }
    }
    const batchLabel = operations.map((operation) => operation.type).join('+');
    const write = this.batchWrite(writes);
    const token = Symbol(batchLabel);
    const previous = this.writeChains.get(sessionId)?.tail ?? Promise.resolve();
    const tail = previous
      .then(write)
      .catch((error: unknown) => {
        this.logWriteFailure(batchLabel, sessionId, error);
      })
      .then(() => {
        if (this.writeChains.get(sessionId)?.token === token) {
          this.writeChains.delete(sessionId);
        }
      });
    this.writeChains.set(sessionId, { tail, token });
  }

  /** Resolves once every write queued so far for the session has run. */
  async flush(sessionId: string): Promise<void> {
    await this.writeChains.get(sessionId)?.tail;
  }

  /** Shutdown: resolves once every session's queue is empty, writes queued meanwhile included. */
  async flushAll(): Promise<void> {
    while (this.writeChains.size > 0) {
      await Promise.all(
        [...this.writeChains.values()].map((writeChain) => writeChain.tail),
      );
    }
  }

  /**
   * Boot: every running session becomes paused at `now` with no deadlines and
   * no remaining time; `isRestartRecovery` marks the ones caught in a phase the
   * resume replays. `last_host_command_at` stays, so the abandonment clock
   * keeps counting from the last host command. Answers the number paused.
   */
  async recoverRunningSessionsAfterRestart(now: Date): Promise<number> {
    const rows: IdRow[] = await this.dataSource.query(
      `WITH "recovered" AS (
         UPDATE "quizshow_sessions"
         SET "status" = 'paused',
             "paused_at" = $1,
             "cursor" = "cursor" || jsonb_build_object(
               'deadline', NULL,
               'extraTimeDeadline', NULL,
               'pausedRemainingMs', NULL,
               'pausedExtraTimeRemainingMs', NULL,
               'isRestartRecovery', ("cursor" ->> 'phase') = ANY($2::text[])
             )
         WHERE "status" = 'running'
         RETURNING "id"
       )
       SELECT "id" FROM "recovered"`,
      [now, [...QUIZSHOW_RESTART_REPLAY_PHASES]],
    );
    return rows.length;
  }

  /** Lobby, running and paused sessions whose last host command is `abandonAfterMs` old or more. */
  async findIdleOpenSessionIds(now: Date): Promise<string[]> {
    const idleSince = new Date(now.getTime() - QUIZSHOW_LIMITS.abandonAfterMs);
    const rows: IdRow[] = await this.dataSource.query(
      `SELECT "session"."id" AS "id"
       FROM "quizshow_sessions" "session"
       WHERE "session"."status" IN ${OPEN_STATUSES_SQL}
         AND "session"."last_host_command_at" <= $1
       ORDER BY "session"."last_host_command_at" ASC`,
      [idleSince],
    );
    return rows.map((row) => row.id);
  }

  /** True when this one session is open and its last host command is `abandonAfterMs` old or more. */
  async isOpenSessionIdle(sessionId: string, now: Date): Promise<boolean> {
    const idleSince = new Date(now.getTime() - QUIZSHOW_LIMITS.abandonAfterMs);
    const rows: IdRow[] = await this.dataSource.query(
      `SELECT "session"."id" AS "id"
       FROM "quizshow_sessions" "session"
       WHERE "session"."id" = $1
         AND "session"."last_host_command_at" <= $2
         AND "session"."status" IN ${OPEN_STATUSES_SQL}`,
      [sessionId, idleSince],
    );
    return rows.length > 0;
  }

  /** Abandons a session no process has loaded: status, `ended_at` and the cursor at `ended`. */
  async markAbandoned(sessionId: string, now: Date): Promise<void> {
    await this.dataSource.query(
      `UPDATE "quizshow_sessions"
       SET "status" = 'abandoned',
           "ended_at" = $2,
           "cursor" = "cursor" || jsonb_build_object(
             'phase', 'ended',
             'roundIndex', NULL,
             'questionIndex', NULL,
             'phaseStartedAt', $3::bigint,
             'deadline', NULL,
             'extraTimeDeadline', NULL,
             'pausedRemainingMs', NULL,
             'pausedExtraTimeRemainingMs', NULL,
             'isRestartRecovery', false,
             'phaseCounter', COALESCE(("cursor" ->> 'phaseCounter')::int, 0) + 1
           )
       WHERE "id" = $1
         AND "status" IN ${OPEN_STATUSES_SQL}`,
      [sessionId, now, now.getTime()],
    );
  }

  async findOpenSessionIdsForEvents(eventIds: string[]): Promise<string[]> {
    if (eventIds.length === 0) return [];
    const rows: IdRow[] = await this.dataSource.query(
      `SELECT "session"."id" AS "id"
       FROM "quizshow_sessions" "session"
       WHERE "session"."event_id" = ANY($1::uuid[])
         AND "session"."status" IN ${OPEN_STATUSES_SQL}`,
      [eventIds],
    );
    return rows.map((row) => row.id);
  }

  /** The lobby, running and paused sessions of these games (quiz ids). */
  async findOpenSessionIdsForGames(gameIds: string[]): Promise<string[]> {
    if (gameIds.length === 0) return [];
    const rows: IdRow[] = await this.dataSource.query(
      `SELECT "session"."id" AS "id"
       FROM "quizshow_sessions" "session"
       WHERE "session"."quiz_id" = ANY($1::uuid[])
         AND "session"."status" IN ${OPEN_STATUSES_SQL}`,
      [gameIds],
    );
    return rows.map((row) => row.id);
  }

  /** The ids of every game the member owns. */
  async findGameIdsOfOwner(userId: string): Promise<string[]> {
    const rows: IdRow[] = await this.dataSource.query(
      `SELECT "quiz"."id" AS "id" FROM "quizshow_quizzes" "quiz" WHERE "quiz"."owner_user_id" = $1`,
      [userId],
    );
    return rows.map((row) => row.id);
  }

  /** Inside the caller's transaction: every vote, answer, player, team and the results row of the session, then `results_kept = false`. */
  async deleteKeptResults(
    manager: EntityManager,
    sessionId: string,
  ): Promise<void> {
    await manager.query(
      `DELETE FROM "quizshow_votes" WHERE "session_id" = $1`,
      [sessionId],
    );
    await manager.query(
      `DELETE FROM "quizshow_answers" WHERE "session_id" = $1`,
      [sessionId],
    );
    await manager.query(
      `DELETE FROM "quizshow_players" WHERE "session_id" = $1`,
      [sessionId],
    );
    await manager.query(
      `DELETE FROM "quizshow_teams" WHERE "session_id" = $1`,
      [sessionId],
    );
    await manager.query(
      `DELETE FROM "quizshow_results" WHERE "session_id" = $1`,
      [sessionId],
    );
    await manager.query(
      `UPDATE "quizshow_sessions" SET "results_kept" = false WHERE "id" = $1`,
      [sessionId],
    );
  }

  private async loadNextEvent(
    seriesId: string | null,
    seriesIndex: number | null,
  ): Promise<QuizshowNextEvent | null> {
    if (seriesId === null || seriesIndex === null) return null;
    const rows: NextEventRow[] = await this.dataSource.query(
      `SELECT "next_event"."slug" AS "slug",
              "next_event"."title" AS "title",
              "next_event"."start_at" AS "start_at"
       FROM "events" "next_event"
       WHERE "next_event"."series_id" = $1
         AND "next_event"."series_index" > $2
         AND "next_event"."status" = 'published'
       ORDER BY "next_event"."series_index" ASC
       LIMIT 1`,
      [seriesId, seriesIndex],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      slug: row.slug,
      title: row.title,
      startAt: new Date(toEpochMs(row.start_at)).toISOString(),
    };
  }

  /** The play of the question the cursor names in `reveal` or `scores`; null anywhere else. */
  private async loadQuestionPlay(
    state: QuizshowLiveState,
    random: QuizshowRandom,
  ): Promise<QuizshowLiveQuestionPlay | null> {
    const { phase, roundIndex, questionIndex } = state.cursor;
    if (
      (phase !== 'reveal' && phase !== 'scores') ||
      roundIndex === null ||
      questionIndex === null
    ) {
      return null;
    }
    const round = state.snapshot.rounds[roundIndex];
    const question = round?.questions[questionIndex];
    if (round === undefined || question === undefined) return null;
    const logEntry = state.questionLog.findLast(
      (entry) => entry.questionId === question.id,
    );
    if (logEntry === undefined) return null;

    const [answerRows, voteRows] = await Promise.all([
      this.dataSource.query<AnswerRow[]>(
        `SELECT "answer"."id" AS "id",
                "answer"."player_id" AS "player_id",
                "answer"."question_id" AS "question_id",
                "answer"."payload" AS "payload",
                "answer"."received_at" AS "received_at",
                "answer"."elapsed_ms" AS "elapsed_ms",
                "answer"."is_correct" AS "is_correct",
                "answer"."points_awarded" AS "points_awarded",
                "answer"."vote_option_id" AS "vote_option_id",
                "answer"."hidden_at" AS "hidden_at"
         FROM "quizshow_answers" "answer"
         WHERE "answer"."session_id" = $1
           AND "answer"."question_id" = $2
         ORDER BY "answer"."received_at" ASC, "answer"."id" ASC`,
        [state.sessionId, question.id],
      ),
      this.dataSource.query<VoteRow[]>(
        `SELECT "vote"."voter_player_id" AS "voter_player_id",
                "vote"."question_id" AS "question_id",
                "vote"."answer_id" AS "answer_id",
                "vote"."created_at" AS "created_at"
         FROM "quizshow_votes" "vote"
         WHERE "vote"."session_id" = $1
           AND "vote"."question_id" = $2
         ORDER BY "vote"."created_at" ASC, "vote"."id" ASC`,
        [state.sessionId, question.id],
      ),
    ]);

    const openedAt = logEntry.openedAt;
    const eligiblePlayers = [...state.players.values()].filter(
      (player) =>
        player.joinedAt <= openedAt &&
        (player.removedAt === null || player.removedAt > openedAt),
    );

    // Mirrors the engine's scoring at reveal: every player still in the
    // question when it was revealed holds an entry, the author shares sit on
    // the answers, Lie Detector truth votes pay their voters and a host
    // favourite shows as its bonus on top of the vote points.
    const revealedAt = logEntry.revealedAt;
    const isInSessionAtReveal = (
      player: Pick<QuizshowLivePlayer, 'removedAt'> | undefined,
    ): boolean =>
      player !== undefined &&
      (player.removedAt === null ||
        (revealedAt !== null && player.removedAt > revealedAt));
    const scoredPlayers = eligiblePlayers.filter((player) =>
      isInSessionAtReveal(player),
    );
    const pointsByPlayer = new Map<string, number>(
      scoredPlayers.map((player) => [player.playerId, 0]),
    );
    const jokerMultiplierFor = (playerId: string): number =>
      isJokerActiveFor(state, playerId, roundIndex)
        ? QUIZSHOW_LIMITS.jokerMultiplier
        : 1;
    const isQuizRound = !isPartyRoundKind(round.kind);

    const phaseId = answeringPhaseId(state, round, answerRows);
    const answers = new Map<string, QuizshowLiveAnswer>();
    for (const row of answerRows) {
      const pointsAwarded = Number(row.points_awarded);
      const streakAfterAnswer = state.players.get(row.player_id)?.streak ?? 0;
      answers.set(row.player_id, {
        answerId: row.id,
        playerId: row.player_id,
        questionId: row.question_id,
        phaseId,
        payload: row.payload,
        receivedAt: toEpochMs(row.received_at),
        elapsedMs: row.elapsed_ms,
        isCorrect: row.is_correct,
        correctPositions: correctPositionsOf(question, row.payload),
        pointsAwarded,
        streakBonus:
          isQuizRound && row.is_correct === true
            ? streakBonusFor(streakAfterAnswer)
            : 0,
        voteOptionId: row.vote_option_id,
        hiddenAt: toEpochMsOrNull(row.hidden_at),
      });
      const pointsSoFar = pointsByPlayer.get(row.player_id);
      if (pointsSoFar !== undefined) {
        pointsByPlayer.set(row.player_id, pointsSoFar + pointsAwarded);
      }
    }

    const voteOptions: QuizshowLiveVoteOption[] = answerRows
      .filter((row) => row.vote_option_id !== null)
      .map((row) => ({
        optionId: row.vote_option_id as string,
        answerId: row.id,
        authorPlayerId: row.player_id,
        text: row.payload.type === 'prompt' ? row.payload.text : '',
        isTruth: false,
      }));
    const optionIdByAnswerId = new Map(
      voteOptions.map((option) => [option.answerId, option.optionId]),
    );
    let truthOptionId: string | null = null;
    // The engine always shows the truth on a Lie Detector question, with or
    // without fakes or votes, so the reload always mints it too.
    if (round.kind === 'lie_detector') {
      truthOptionId = random.uuid();
      voteOptions.splice(random.integerBelow(voteOptions.length + 1), 0, {
        optionId: truthOptionId,
        answerId: null,
        authorPlayerId: null,
        text: truthText(
          question.type === 'prompt' ? question.answer?.truth : undefined,
          state.snapshot.screenLanguage,
        ),
        isTruth: true,
      });
    }

    const votes = new Map<string, QuizshowLiveVote>();
    const voteCountByAnswerId = new Map<string, number>();
    for (const row of voteRows) {
      const optionId =
        row.answer_id === null
          ? truthOptionId
          : (optionIdByAnswerId.get(row.answer_id) ?? null);
      if (optionId === null) continue;
      votes.set(row.voter_player_id, {
        voterPlayerId: row.voter_player_id,
        questionId: row.question_id,
        optionId,
        answerId: row.answer_id,
        createdAt: toEpochMs(row.created_at),
      });
      // Scoring at reveal counted no vote of a voter removed by then.
      if (!isInSessionAtReveal(state.players.get(row.voter_player_id))) {
        continue;
      }
      if (row.answer_id !== null) {
        voteCountByAnswerId.set(
          row.answer_id,
          (voteCountByAnswerId.get(row.answer_id) ?? 0) + 1,
        );
        continue;
      }
      const voterPointsSoFar = pointsByPlayer.get(row.voter_player_id);
      if (voterPointsSoFar !== undefined) {
        pointsByPlayer.set(
          row.voter_player_id,
          voterPointsSoFar +
            QUIZSHOW_LIMITS.lieDetectorTruthPoints *
              jokerMultiplierFor(row.voter_player_id),
        );
      }
    }

    // The favourite is the visible answer whose points exceed its vote
    // points by exactly the favourite bonus, both under the author's joker.
    let favouriteOptionId: string | null = null;
    if (round.kind === 'caption_this' || round.kind === 'drag_name') {
      const favouriteRow = answerRows.find((row) => {
        if (row.vote_option_id === null || row.hidden_at !== null) return false;
        const multiplier = jokerMultiplierFor(row.player_id);
        const votePoints =
          QUIZSHOW_LIMITS.partyVotePoints *
          (voteCountByAnswerId.get(row.id) ?? 0) *
          multiplier;
        return (
          Number(row.points_awarded) - votePoints ===
          QUIZSHOW_LIMITS.hostFavouritePoints * multiplier
        );
      });
      favouriteOptionId = favouriteRow?.vote_option_id ?? null;
    }

    const teamPoints =
      state.playMode === 'teams'
        ? // Members present at open, as the engine's applyTeamPoints: a
          // member removed before the reveal stays in the divisor at 0.
          teamQuestionPoints(
            eligiblePlayers.flatMap((player) =>
              player.teamId === null
                ? []
                : [{ playerId: player.playerId, teamId: player.teamId }],
            ),
            pointsByPlayer,
          )
        : new Map<string, number>();

    return {
      questionId: question.id,
      roundIndex,
      questionIndex,
      openedAt,
      eligiblePlayerIds: new Set(
        eligiblePlayers.map((player) => player.playerId),
      ),
      extraTimePlayerIds: new Set(
        eligiblePlayers
          .filter((player) => player.hasExtraTime)
          .map((player) => player.playerId),
      ),
      answers,
      votes,
      voteOptions: voteOptions.length > 0 ? voteOptions : null,
      favouriteOptionId,
      isScored: true,
      wasSkipped: logEntry.wasSkipped,
      pointsByPlayer,
      teamPoints,
    };
  }

  /** Builds the write with every value copied out of `state` and `operation` now. */
  private prepareWrite(
    state: QuizshowLiveState,
    operation: QuizshowPersistOperation,
  ): PreparedWrite {
    const sessionId = state.sessionId;
    switch (operation.type) {
      case 'insert_player': {
        const player = operation.player;
        return this.statementsWrite(false, [
          {
            sql: `INSERT INTO "quizshow_players" ("id", "session_id", "user_id", "is_cohost_player", "team_id", "screen_name", "is_avatar_shown", "has_extra_time", "score", "streak", "has_used_joker", "joker_round_index", "removed_at", "joined_at")
                  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            params: [
              player.playerId,
              sessionId,
              player.userId,
              player.isCohostPlayer,
              player.teamId,
              player.screenName,
              player.isAvatarShown,
              player.hasExtraTime,
              player.score,
              player.streak,
              player.hasUsedJoker,
              player.jokerRoundIndex,
              toDateOrNull(player.removedAt),
              new Date(player.joinedAt),
            ],
          },
        ]);
      }
      case 'update_player': {
        const fields = operation.fields;
        const assignments: Array<[string, unknown]> = [];
        if (fields.screenName !== undefined) {
          assignments.push(['screen_name', fields.screenName]);
        }
        if (fields.teamId !== undefined) {
          assignments.push(['team_id', fields.teamId]);
        }
        if (fields.isAvatarShown !== undefined) {
          assignments.push(['is_avatar_shown', fields.isAvatarShown]);
        }
        if (fields.hasExtraTime !== undefined) {
          assignments.push(['has_extra_time', fields.hasExtraTime]);
        }
        if (fields.hasUsedJoker !== undefined) {
          assignments.push(['has_used_joker', fields.hasUsedJoker]);
        }
        if (fields.jokerRoundIndex !== undefined) {
          assignments.push(['joker_round_index', fields.jokerRoundIndex]);
        }
        if (fields.removedAt !== undefined) {
          assignments.push(['removed_at', toDateOrNull(fields.removedAt)]);
        }
        return this.statementsWrite(
          false,
          rowUpdate(
            'quizshow_players',
            sessionId,
            operation.playerId,
            assignments,
          ),
        );
      }
      case 'insert_team': {
        const team = operation.team;
        return this.statementsWrite(false, [
          {
            sql: `INSERT INTO "quizshow_teams" ("id", "session_id", "name", "color_key", "score", "has_used_joker", "joker_round_index", "created_at")
                  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            params: [
              team.teamId,
              sessionId,
              team.name,
              team.colorKey,
              team.score,
              team.hasUsedJoker,
              team.jokerRoundIndex,
              new Date(team.createdAt),
            ],
          },
        ]);
      }
      case 'update_team': {
        const fields = operation.fields;
        const assignments: Array<[string, unknown]> = [];
        if (fields.name !== undefined) assignments.push(['name', fields.name]);
        if (fields.hasUsedJoker !== undefined) {
          assignments.push(['has_used_joker', fields.hasUsedJoker]);
        }
        if (fields.jokerRoundIndex !== undefined) {
          assignments.push(['joker_round_index', fields.jokerRoundIndex]);
        }
        return this.statementsWrite(
          false,
          rowUpdate('quizshow_teams', sessionId, operation.teamId, assignments),
        );
      }
      case 'delete_teams':
        if (operation.teamIds.length === 0)
          return this.statementsWrite(false, []);
        return this.statementsWrite(false, [
          {
            sql: `DELETE FROM "quizshow_teams" WHERE "session_id" = $1 AND "id" = ANY($2::uuid[])`,
            params: [sessionId, [...operation.teamIds]],
          },
        ]);
      case 'insert_answer': {
        const answer = operation.answer;
        return this.statementsWrite(false, [
          {
            sql: `INSERT INTO "quizshow_answers" ("id", "session_id", "question_id", "player_id", "payload", "received_at", "elapsed_ms", "is_correct", "points_awarded", "vote_option_id", "hidden_at")
                  VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)`,
            params: [
              answer.answerId,
              sessionId,
              answer.questionId,
              answer.playerId,
              JSON.stringify(answer.payload),
              new Date(answer.receivedAt),
              answer.elapsedMs,
              answer.isCorrect,
              answer.pointsAwarded,
              answer.voteOptionId,
              toDateOrNull(answer.hiddenAt),
            ],
          },
        ]);
      }
      case 'insert_vote': {
        const vote = operation.vote;
        return this.statementsWrite(false, [
          {
            sql: `INSERT INTO "quizshow_votes" ("session_id", "question_id", "voter_player_id", "answer_id", "created_at")
                  VALUES ($1, $2, $3, $4, $5)`,
            params: [
              sessionId,
              vote.questionId,
              vote.voterPlayerId,
              vote.answerId,
              new Date(vote.createdAt),
            ],
          },
        ]);
      }
      case 'set_answer_vote_options':
        if (operation.options.length === 0) {
          return this.statementsWrite(false, []);
        }
        return this.statementsWrite(false, [
          {
            sql: `UPDATE "quizshow_answers" "answer"
                  SET "vote_option_id" = "option"."vote_option_id"
                  FROM unnest($2::uuid[], $3::uuid[]) AS "option"("answer_id", "vote_option_id")
                  WHERE "answer"."session_id" = $1
                    AND "answer"."id" = "option"."answer_id"`,
            params: [
              sessionId,
              operation.options.map((option) => option.answerId),
              operation.options.map((option) => option.voteOptionId),
            ],
          },
        ]);
      case 'save_scoring': {
        const statements: SqlStatement[] = [];
        if (operation.answers.length > 0) {
          statements.push({
            sql: `UPDATE "quizshow_answers" "answer"
                  SET "is_correct" = "scored"."is_correct",
                      "points_awarded" = "scored"."points_awarded"
                  FROM unnest($2::uuid[], $3::boolean[], $4::int[]) AS "scored"("id", "is_correct", "points_awarded")
                  WHERE "answer"."session_id" = $1
                    AND "answer"."id" = "scored"."id"`,
            params: [
              sessionId,
              operation.answers.map((answer) => answer.answerId),
              operation.answers.map((answer) => answer.isCorrect),
              operation.answers.map((answer) => answer.pointsAwarded),
            ],
          });
        }
        if (operation.players.length > 0) {
          statements.push({
            sql: `UPDATE "quizshow_players" "player"
                  SET "score" = "scored"."score",
                      "streak" = "scored"."streak"
                  FROM unnest($2::uuid[], $3::int[], $4::int[]) AS "scored"("id", "score", "streak")
                  WHERE "player"."session_id" = $1
                    AND "player"."id" = "scored"."id"`,
            params: [
              sessionId,
              operation.players.map((player) => player.playerId),
              operation.players.map((player) => player.score),
              operation.players.map((player) => player.streak),
            ],
          });
        }
        if (operation.teams.length > 0) {
          statements.push({
            sql: `UPDATE "quizshow_teams" "team"
                  SET "score" = "scored"."score"
                  FROM unnest($2::uuid[], $3::int[]) AS "scored"("id", "score")
                  WHERE "team"."session_id" = $1
                    AND "team"."id" = "scored"."id"`,
            params: [
              sessionId,
              operation.teams.map((team) => team.teamId),
              operation.teams.map((team) => team.score),
            ],
          });
        }
        return this.statementsWrite(true, statements);
      }
      case 'set_answer_hidden':
        return this.statementsWrite(false, [
          {
            sql: `UPDATE "quizshow_answers"
                  SET "hidden_at" = $3, "hidden_by_user_id" = $4
                  WHERE "session_id" = $1 AND "id" = $2`,
            params: [
              sessionId,
              operation.answerId,
              toDateOrNull(operation.hiddenAt),
              operation.hiddenByUserId,
            ],
          },
        ]);
      case 'hide_player_answers':
        return this.statementsWrite(false, [
          {
            sql: `UPDATE "quizshow_answers"
                  SET "hidden_at" = $3, "hidden_by_user_id" = $4
                  WHERE "session_id" = $1
                    AND "player_id" = $2
                    AND "hidden_at" IS NULL`,
            params: [
              sessionId,
              operation.playerId,
              new Date(operation.hiddenAt),
              operation.hiddenByUserId,
            ],
          },
        ]);
      case 'delete_question_plays':
        return this.statementsWrite(true, [
          {
            sql: `DELETE FROM "quizshow_votes" WHERE "session_id" = $1 AND "question_id" = $2`,
            params: [sessionId, operation.questionId],
          },
          {
            sql: `DELETE FROM "quizshow_answers" WHERE "session_id" = $1 AND "question_id" = $2`,
            params: [sessionId, operation.questionId],
          },
        ]);
      case 'checkpoint':
        // The finish and abandon writes carry the closing status, ended_at
        // and cursor; a closing checkpoint ahead of them would end the row
        // first and leave them matching nothing.
        if (state.status === 'finished' || state.status === 'abandoned') {
          return this.statementsWrite(false, []);
        }
        return this.statementsWrite(false, [
          {
            sql: `UPDATE "quizshow_sessions"
                  SET "status" = $2,
                      "cursor" = $3::jsonb,
                      "question_log" = $4::jsonb,
                      "paused_at" = $5,
                      "last_host_command_at" = $6
                  WHERE "id" = $1
                    AND "status" IN ${OPEN_STATUSES_SQL}`,
            params: [
              sessionId,
              state.status,
              JSON.stringify(toStoredCursor(state)),
              JSON.stringify(state.questionLog),
              toDateOrNull(state.pausedAt),
              new Date(state.lastHostCommandAt),
            ],
          },
        ]);
      case 'add_attached_organiser':
        return this.statementsWrite(false, [
          {
            sql: `UPDATE "quizshow_sessions"
                  SET "attached_organiser_user_ids" = array_append("attached_organiser_user_ids", $2::uuid)
                  WHERE "id" = $1
                    AND NOT ($2::uuid = ANY("attached_organiser_user_ids"))`,
            params: [sessionId, operation.userId],
          },
        ]);
      case 'finish':
        return this.prepareFinish(state, operation.podium, operation.placings);
      case 'abandon':
        return this.statementsWrite(false, [
          {
            sql: `UPDATE "quizshow_sessions"
                  SET "status" = 'abandoned',
                      "ended_at" = $2,
                      "cursor" = $3::jsonb,
                      "question_log" = $4::jsonb,
                      "paused_at" = NULL
                  WHERE "id" = $1
                    AND "status" IN ${OPEN_STATUSES_SQL}`,
            params: [
              sessionId,
              endedAtOf(state),
              JSON.stringify(toStoredCursor(state)),
              JSON.stringify(state.questionLog),
            ],
          },
        ]);
    }
  }

  /**
   * One transaction: the session turns `finished` with its final cursor and
   * question log, then the results row takes the podium, the placings and the
   * recap built from the log and one aggregate over the session's answers.
   */
  private prepareFinish(
    state: QuizshowLiveState,
    podium: QuizshowStoredPodiumEntry[],
    placings: Record<string, number>,
  ): PreparedWrite {
    const sessionId = state.sessionId;
    const endedAt = endedAtOf(state);
    const storedCursorJson = JSON.stringify(toStoredCursor(state));
    const questionLog = structuredClone(state.questionLog);
    const podiumJson = JSON.stringify(podium);
    const placingsJson = JSON.stringify(placings);
    const recapSources: RecapSource[] = questionLog.map((entry) => ({
      entry,
      prompt: structuredClone(
        snapshotQuestionAt(
          state.snapshot,
          entry.roundIndex,
          entry.questionIndex,
        )?.prompt ?? { en: '', pt: '' },
      ),
    }));
    return {
      isTransaction: true,
      isEmpty: false,
      run: async (manager) => {
        const finishedRows: IdRow[] = await manager.query(
          `WITH "finished" AS (
             UPDATE "quizshow_sessions"
             SET "status" = 'finished',
                 "ended_at" = $2,
                 "cursor" = $3::jsonb,
                 "question_log" = $4::jsonb,
                 "paused_at" = NULL
             WHERE "id" = $1
               AND "status" IN ${OPEN_STATUSES_SQL}
             RETURNING "id"
           )
           SELECT "id" FROM "finished"`,
          [sessionId, endedAt, storedCursorJson, JSON.stringify(questionLog)],
        );
        if (finishedRows.length === 0) return;
        const aggregateRows: QuestionAggregateRow[] = await manager.query(
          `SELECT "answer"."question_id" AS "question_id",
                  COUNT(*)::int AS "answer_count",
                  (COUNT(*) FILTER (WHERE "answer"."is_correct" IS TRUE))::int AS "correct_count",
                  AVG("answer"."elapsed_ms")::float8 AS "average_elapsed_ms"
           FROM "quizshow_answers" "answer"
           WHERE "answer"."session_id" = $1
           GROUP BY "answer"."question_id"`,
          [sessionId],
        );
        const recap = buildQuizshowRecap(recapSources, aggregateRows);
        await manager.query(
          `INSERT INTO "quizshow_results" ("session_id", "podium", "placings", "question_stats")
           VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb)`,
          [sessionId, podiumJson, placingsJson, JSON.stringify(recap)],
        );
      },
    };
  }

  private statementsWrite(
    isTransaction: boolean,
    statements: SqlStatement[],
  ): PreparedWrite {
    return {
      isTransaction,
      isEmpty: statements.length === 0,
      run: async (queryTarget) => {
        for (const statement of statements) {
          await queryTarget.query(statement.sql, statement.params);
        }
      },
    };
  }

  /**
   * The write of one batch: a lone plain write runs on the data source;
   * two writes or more, or one that needs a transaction, run in one
   * transaction, so a failure anywhere rolls every one of them back.
   */
  private batchWrite(writes: readonly PreparedWrite[]): () => Promise<void> {
    const writesToRun = writes.filter((write) => !write.isEmpty);
    return async () => {
      const [onlyWrite] = writesToRun;
      if (onlyWrite === undefined) return;
      if (writesToRun.length === 1 && !onlyWrite.isTransaction) {
        await onlyWrite.run(this.dataSource);
        return;
      }
      await this.dataSource.transaction(async (manager) => {
        for (const write of writesToRun) {
          await write.run(manager);
        }
      });
    };
  }

  /** `operationLabel` is one operation type, or the types of a batch joined by `+`. */
  private logWriteFailure(
    operationLabel: string,
    sessionId: string,
    error: unknown,
  ): void {
    this.logger.error(
      `Pulse Live write ${operationLabel} failed for session ${sessionId} (${quizshowWriteFailureCode(error)})`,
    );
  }
}

/** `UPDATE <table> SET ... WHERE session and id`, or nothing when no field changed. */
function rowUpdate(
  tableName: 'quizshow_players' | 'quizshow_teams',
  sessionId: string,
  rowId: string,
  assignments: ReadonlyArray<[string, unknown]>,
): SqlStatement[] {
  if (assignments.length === 0) return [];
  const setList = assignments
    .map(([columnName], position) => `"${columnName}" = $${position + 3}`)
    .join(', ');
  return [
    {
      sql: `UPDATE "${tableName}" SET ${setList} WHERE "session_id" = $1 AND "id" = $2`,
      params: [sessionId, rowId, ...assignments.map(([, value]) => value)],
    },
  ];
}
