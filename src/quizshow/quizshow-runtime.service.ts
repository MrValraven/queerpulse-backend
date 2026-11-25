/**
 * Pulse Live (`quizshow`) runtime: owns every live session in memory. It loads
 * a session once however many sockets attach at the same moment, runs each
 * command through the engine, then applies the engine's effects in order:
 * frames to the session's rooms, one phase timer per session, trailing
 * throttles for lobby updates, answer counts and reactions, and the
 * persistence queue. It also pauses running sessions on boot and abandons
 * idle ones.
 *
 * Log lines name session ids, player ids and error codes only.
 */
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { Namespace, Socket } from 'socket.io';
import {
  QUIZSHOW_LIMITS,
  type QuizshowMyAnswer,
  type QuizshowReactionId,
  type QuizshowReactionsFrame,
  type QuizshowRematch,
} from './quizshow.contract';
import {
  abandonIfIdle as abandonIfIdleInEngine,
  abandonNow,
  closeIfEveryoneDone,
  timerElapsed,
} from './quizshow-engine-phases';
import {
  activePlayers,
  buildRankIndex,
  succeed,
  toMe,
} from './quizshow-engine-state';
import type {
  QuizshowCommandOutcome,
  QuizshowEngineEffect,
  QuizshowLiveState,
} from './quizshow-engine-types';
import {
  buildAnswerCount,
  buildHostLobby,
  buildHostVoteOptions,
  buildLobby,
  buildMyReveal,
  buildMyScores,
  buildPairedDevices,
  buildPhaseChange,
  buildPlayerLobby,
  buildPodiumFrame,
  buildReveal,
  buildReviewList,
  buildScores,
  buildSessionEnd,
  buildSessionFlags,
  buildSessionState,
  buildTypedAnswers,
  buildVoteOptions,
  quizshowPlayerRoomName,
  visibleVoteOptions,
  quizshowRoomName,
  type QuizshowRoleRoom,
  type QuizshowSessionStateViewer,
} from './quizshow-frames';
import {
  QuizshowPersistenceService,
  quizshowWriteFailureCode,
} from './quizshow-persistence.service';
import { CRYPTO_RANDOM, type QuizshowRandom } from './quizshow-snapshot';

/** Injection token for the randomness the engine uses; `CRYPTO_RANDOM` when absent. */
export const QUIZSHOW_RANDOM = Symbol('QUIZSHOW_RANDOM');

/** Trailing throttle of `lobby:update`. */
export const QUIZSHOW_LOBBY_THROTTLE_MS = 500;
/** Trailing throttle of `answer:count`. */
export const QUIZSHOW_ANSWER_COUNT_THROTTLE_MS = 250;
/**
 * The longest shutdown waits for queued writes, as the chat gateway's drain;
 * `main.ts`'s hard shutdown ceiling stays well above it.
 */
export const QUIZSHOW_SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;

const ROLE_ROOMS: readonly QuizshowRoleRoom[] = ['screen', 'players', 'hosts'];
const PUBLIC_ROOMS: readonly QuizshowRoleRoom[] = ['screen', 'players'];

type QuizshowTimerHandle = ReturnType<typeof setTimeout>;

/** The part of the gateway's socket data the runtime reads and clears. */
interface QuizshowRuntimeSocketData {
  /** The session this socket attaches to; set when an attach starts. */
  sessionId?: string;
  /** The player row this socket counts for; null until it joins or after a leave. */
  playerId?: string | null;
  /** The admitted member; unset on a paired TV's socket. */
  userId?: string;
  /** The role this socket attached as; set once an attach succeeds. */
  role?: string;
}

type QuizshowAbandonCheck = (
  state: QuizshowLiveState,
  now: number,
) => QuizshowEngineEffect[];

export interface QuizshowExecuteOptions {
  /** An answer or a vote: the phase closes early once every eligible player is done. */
  isSubmission?: boolean;
}

function hasSessionEnded(effects: readonly QuizshowEngineEffect[]): boolean {
  return effects.some((effect) => effect.kind === 'session_ended');
}

@Injectable()
export class QuizshowRuntimeService
  implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown
{
  private readonly logger = new Logger(QuizshowRuntimeService.name);
  /** The engine's randomness; the gateway passes the same one to the player commands. */
  readonly random: QuizshowRandom;
  private namespace: Namespace | null = null;
  private readonly liveStates = new Map<string, QuizshowLiveState>();
  private readonly loadingStates = new Map<
    string,
    Promise<QuizshowLiveState | null>
  >();
  /** Sessions whose end is still flushing its writes; a load waits for it. */
  private readonly endingSessions = new Map<string, Promise<void>>();
  private readonly phaseTimers = new Map<string, QuizshowTimerHandle>();
  private readonly lobbyThrottles = new Map<string, QuizshowTimerHandle>();
  private readonly answerCountThrottles = new Map<
    string,
    QuizshowTimerHandle
  >();
  private readonly reactionThrottles = new Map<string, QuizshowTimerHandle>();
  /** Reactions received in the open window, by session: anonymous counts per reaction id. */
  private readonly reactionCounts = new Map<
    string,
    Map<QuizshowReactionId, number>
  >();

  constructor(
    private readonly persistence: QuizshowPersistenceService,
    @Optional() @Inject(QUIZSHOW_RANDOM) random?: QuizshowRandom,
  ) {
    this.random = random ?? CRYPTO_RANDOM;
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      const pausedCount =
        await this.persistence.recoverRunningSessionsAfterRestart(new Date());
      this.logger.log(
        `Pulse Live paused ${pausedCount} running sessions after a restart`,
      );
    } catch (error: unknown) {
      this.logger.error(
        `Pulse Live restart recovery failed: ${quizshowWriteFailureCode(error)}`,
      );
    }
  }

  onModuleDestroy(): void {
    for (const timers of [
      this.phaseTimers,
      this.lobbyThrottles,
      this.answerCountThrottles,
      this.reactionThrottles,
    ]) {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    }
    this.reactionCounts.clear();
  }

  /**
   * Shutdown runs after `onModuleDestroy` stopped the timers: waits for every
   * session's queued writes and every ending in flight, bounded by
   * `QUIZSHOW_SHUTDOWN_DRAIN_TIMEOUT_MS` so a stuck write cannot hang the
   * deploy, as the chat gateway's drain.
   */
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(
      `Pulse Live draining queued writes for shutdown (signal: ${signal ?? 'unknown'})`,
    );
    let drainTimer: QuizshowTimerHandle | undefined;
    const drainTimedOut = new Promise<boolean>((resolve) => {
      drainTimer = setTimeout(
        () => resolve(false),
        QUIZSHOW_SHUTDOWN_DRAIN_TIMEOUT_MS,
      );
      drainTimer.unref();
    });
    const drained = Promise.all([
      this.persistence.flushAll(),
      ...this.endingSessions.values(),
    ]).then(() => true);
    try {
      const isDrained = await Promise.race([drained, drainTimedOut]);
      if (!isDrained) {
        this.logger.warn(
          `Pulse Live shutdown proceeding with writes still queued after ${QUIZSHOW_SHUTDOWN_DRAIN_TIMEOUT_MS}ms`,
        );
      }
    } catch (error: unknown) {
      this.logger.error(
        `Pulse Live shutdown drain failed: ${quizshowWriteFailureCode(error)}`,
      );
    } finally {
      clearTimeout(drainTimer);
    }
  }

  /** The gateway hands over its namespace from `afterInit`. */
  bindNamespace(namespace: Namespace): void {
    this.namespace = namespace;
  }

  /** The live state already in memory, or null; never reads the database (a `session:ping` must stay cheap). */
  peekLiveState(sessionId: string): QuizshowLiveState | null {
    return this.liveStates.get(sessionId) ?? null;
  }

  /** The loaded live state, or one read once from the database however many callers ask at the same moment. */
  async getOrLoad(sessionId: string): Promise<QuizshowLiveState | null> {
    const loadedState = this.liveStates.get(sessionId);
    if (loadedState !== undefined) return loadedState;
    const pendingLoad = this.loadingStates.get(sessionId);
    if (pendingLoad !== undefined) return pendingLoad;
    const loading = this.loadState(sessionId);
    this.loadingStates.set(sessionId, loading);
    try {
      return await loading;
    } finally {
      if (this.loadingStates.get(sessionId) === loading) {
        this.loadingStates.delete(sessionId);
      }
    }
  }

  /**
   * Runs one command on the live state at `Date.now()`, adds the early close
   * for a submission, and applies every effect in order before resolving;
   * null when the session is not live.
   */
  async execute<Success extends object>(
    sessionId: string,
    command: (
      state: QuizshowLiveState,
      now: number,
    ) => QuizshowCommandOutcome<Success>,
    options: QuizshowExecuteOptions = {},
  ): Promise<QuizshowCommandOutcome<Success> | null> {
    const state = await this.getOrLoad(sessionId);
    if (state === null || this.liveStates.get(sessionId) !== state) {
      return null;
    }
    const now = Date.now();
    const outcome = command(state, now);
    if (!outcome.ok) return outcome;
    const effects =
      options.isSubmission === true
        ? [...outcome.effects, ...closeIfEveryoneDone(state, now, this.random)]
        : outcome.effects;
    await this.applyEffects(state, effects);
    return { ...outcome, effects };
  }

  /** Resolves once every write queued so far for the session has run. */
  async flushWrites(sessionId: string): Promise<void> {
    await this.persistence.flush(sessionId);
  }

  /** Abandons the session when its last host command is 2 hours old; true when it ended. */
  async abandonIfIdle(sessionId: string, now: number): Promise<boolean> {
    await this.endingSessions.get(sessionId);
    if (this.isInMemory(sessionId)) {
      return this.abandonSession(sessionId, now, abandonIfIdleInEngine, false);
    }
    const isIdleInDatabase = await this.persistence.isOpenSessionIdle(
      sessionId,
      new Date(now),
    );
    return this.abandonSession(
      sessionId,
      now,
      abandonIfIdleInEngine,
      isIdleInDatabase,
    );
  }

  /** The events were cancelled or deleted: every open session of theirs ends with no results. */
  async abandonSessionsOfEvents(
    eventIds: string[],
    now: number,
  ): Promise<void> {
    if (eventIds.length === 0) return;
    const eventIdSet = new Set(eventIds);
    const storedSessionIds =
      await this.persistence.findOpenSessionIdsForEvents(eventIds);
    const loadedSessionIds = [...this.liveStates.values()]
      .filter(
        (state) => state.eventId !== null && eventIdSet.has(state.eventId),
      )
      .map((state) => state.sessionId);
    await this.abandonSessionIds(
      new Set([...storedSessionIds, ...loadedSessionIds]),
      now,
    );
  }

  /** The games were deleted or their owner left: every open session of theirs ends with no results. */
  async abandonSessionsOfGames(gameIds: string[], now: number): Promise<void> {
    if (gameIds.length === 0) return;
    const gameIdSet = new Set(gameIds);
    const storedSessionIds =
      await this.persistence.findOpenSessionIdsForGames(gameIds);
    const loadedSessionIds = [...this.liveStates.values()]
      .filter((state) => state.gameId !== null && gameIdSet.has(state.gameId))
      .map((state) => state.sessionId);
    await this.abandonSessionIds(
      new Set([...storedSessionIds, ...loadedSessionIds]),
      now,
    );
  }

  /** The owner's account is going away: every open session of every game they own ends. */
  async abandonSessionsOfOwner(userId: string, now: number): Promise<void> {
    const gameIds = await this.persistence.findGameIdsOfOwner(userId);
    await this.abandonSessionsOfGames(gameIds, now);
  }

  private async abandonSessionIds(
    sessionIds: Iterable<string>,
    now: number,
  ): Promise<void> {
    for (const sessionId of sessionIds) {
      try {
        await this.abandonSession(sessionId, now, abandonNow, true);
      } catch (error: unknown) {
        this.logger.error(
          `Pulse Live session ${sessionId} could not be abandoned: ${quizshowWriteFailureCode(error)}`,
        );
      }
    }
  }

  /** Abandons every idle open session, loaded or not; answers how many ended. */
  async sweepIdleSessions(now: number): Promise<number> {
    const idleSessionIds = new Set(
      await this.persistence.findIdleOpenSessionIds(new Date(now)),
    );
    let abandonedCount = 0;
    for (const sessionId of new Set([
      ...idleSessionIds,
      ...this.liveStates.keys(),
    ])) {
      try {
        const hasEnded = await this.abandonSession(
          sessionId,
          now,
          abandonIfIdleInEngine,
          idleSessionIds.has(sessionId),
        );
        if (hasEnded) abandonedCount += 1;
      } catch (error: unknown) {
        this.logger.error(
          `Pulse Live session ${sessionId} could not be abandoned: ${quizshowWriteFailureCode(error)}`,
        );
      }
    }
    return abandonedCount;
  }

  /** A socket of the player joined the session; hosts see them connected. */
  noteSocketAttached(sessionId: string, playerId: string | null): void {
    if (playerId === null) return;
    const player = this.liveStates.get(sessionId)?.players.get(playerId);
    if (player === undefined) return;
    player.connectedSocketCount += 1;
    player.disconnectedAt = null;
    if (player.connectedSocketCount === 1) this.scheduleLobbyUpdate(sessionId);
  }

  /** A socket of the player left; once none is left, hosts see them disconnected and the away clock starts (contract 6.2). */
  noteSocketDetached(sessionId: string, playerId: string | null): void {
    if (playerId === null) return;
    const player = this.liveStates.get(sessionId)?.players.get(playerId);
    if (player === undefined || player.connectedSocketCount === 0) return;
    player.connectedSocketCount -= 1;
    if (player.connectedSocketCount === 0) {
      player.disconnectedAt = Date.now();
      this.scheduleLobbyUpdate(sessionId);
    }
  }

  /** A socket of a paired screen or helper attached; hosts see the device connected. */
  noteDeviceSocketAttached(sessionId: string, pairingId: string): void {
    this.moveDeviceSocketCount(sessionId, pairingId, 1);
  }

  /** A socket of a paired screen or helper left; hosts see the device disconnected once none is left. */
  noteDeviceSocketDetached(sessionId: string, pairingId: string): void {
    this.moveDeviceSocketCount(sessionId, pairingId, -1);
  }

  /**
   * `session:rematch` to the old session's role rooms: its sockets stay in
   * them after the end, so phones and the remote can offer the new lobby
   * (contract 6.17).
   */
  emitRematch(fromSessionId: string, rematch: QuizshowRematch): void {
    this.emitToRoles(fromSessionId, ROLE_ROOMS, 'session:rematch', rematch);
  }

  /** `session:state` to one socket, filtered for its role. */
  emitSessionState(
    socket: Socket,
    state: QuizshowLiveState,
    viewer: Parameters<typeof buildSessionState>[1],
  ): void {
    socket.emit('session:state', buildSessionState(state, viewer));
  }

  private isInMemory(sessionId: string): boolean {
    return this.liveStates.has(sessionId) || this.loadingStates.has(sessionId);
  }

  /**
   * A loaded session runs the engine check; an unloaded one is marked
   * abandoned in the database when `isIdleInDatabase` says it qualifies.
   */
  private async abandonSession(
    sessionId: string,
    now: number,
    abandonCheck: QuizshowAbandonCheck,
    isIdleInDatabase: boolean,
  ): Promise<boolean> {
    await this.endingSessions.get(sessionId);
    if (this.isInMemory(sessionId)) {
      const outcome = await this.execute(sessionId, (state) =>
        succeed<Record<string, never>>({}, abandonCheck(state, now)),
      );
      return outcome !== null && hasSessionEnded(outcome.effects);
    }
    if (!isIdleInDatabase) return false;
    await this.trackEnding(
      sessionId,
      this.persistence.markAbandoned(sessionId, new Date(now)),
    );
    return true;
  }

  /**
   * Registers a session's end (its last writes, or the abandon of an unloaded
   * row) for as long as it runs, so a load in between waits for it; a failure
   * still rejects for the caller and never for the waiting load.
   */
  private async trackEnding(
    sessionId: string,
    ending: Promise<void>,
  ): Promise<void> {
    const settled = ending.then(
      () => undefined,
      () => undefined,
    );
    this.endingSessions.set(sessionId, settled);
    try {
      await ending;
    } finally {
      if (this.endingSessions.get(sessionId) === settled) {
        this.endingSessions.delete(sessionId);
      }
    }
  }

  private async loadState(
    sessionId: string,
  ): Promise<QuizshowLiveState | null> {
    await this.endingSessions.get(sessionId);
    const state = await this.persistence.loadLiveState(sessionId, this.random);
    if (state === null) return null;
    this.liveStates.set(sessionId, state);
    this.rearmPhaseTimer(state);
    return state;
  }

  /**
   * A running session read from the database (boot recovery failed) keeps its
   * phase timer; an untimed phase with auto-advance armed keeps that timer
   * (contract 6.16).
   */
  private rearmPhaseTimer(state: QuizshowLiveState): void {
    const { autoAdvanceAt, deadline, phase, phaseId } = state.cursor;
    if (state.status !== 'running') return;
    if (deadline !== null) {
      const fireAt =
        phase === 'read' ? deadline : deadline + QUIZSHOW_LIMITS.answerGraceMs;
      this.setPhaseTimer(state.sessionId, phaseId, fireAt);
      return;
    }
    if (autoAdvanceAt !== null) {
      this.setPhaseTimer(state.sessionId, phaseId, autoAdvanceAt);
    }
  }

  private async applyEffects(
    state: QuizshowLiveState,
    effects: readonly QuizshowEngineEffect[],
  ): Promise<void> {
    let hasEnded = false;
    // Every write of one command goes in one batch, queued before any frame
    // is built: they commit together, and a frame that throws still leaves
    // the database matching the state in memory.
    this.persistence.enqueueBatch(
      state,
      effects.flatMap((effect) =>
        effect.kind === 'persist' ? [effect.operation] : [],
      ),
    );
    try {
      for (const effect of effects) {
        if (effect.kind === 'session_ended') {
          hasEnded = true;
          this.emitToRoles(
            state.sessionId,
            ROLE_ROOMS,
            'session:end',
            buildSessionEnd(state),
          );
          continue;
        }
        this.applyEffect(state, effect);
      }
    } finally {
      // A throw later in the list still tears the ended session down.
      if (hasEnded) await this.endSession(state);
    }
  }

  private applyEffect(
    state: QuizshowLiveState,
    effect: Exclude<QuizshowEngineEffect, { kind: 'session_ended' }>,
  ): void {
    const { sessionId } = state;
    switch (effect.kind) {
      case 'phase_changed':
        this.emitToRoles(
          sessionId,
          PUBLIC_ROOMS,
          'phase:change',
          buildPhaseChange(state, 'public'),
        );
        this.emitToRoles(
          sessionId,
          ['hosts'],
          'phase:change',
          buildPhaseChange(state, 'host'),
        );
        return;
      case 'lobby_changed':
        this.scheduleLobbyUpdate(sessionId);
        return;
      case 'me_changed':
        for (const playerId of effect.playerIds) {
          if (!state.players.has(playerId)) continue;
          this.emitToPlayer(sessionId, playerId, 'me:update', {
            me: toMe(state, playerId),
          });
        }
        return;
      case 'answer_accepted':
        this.emitAnswerAck(state, effect.playerId, effect.questionId);
        return;
      case 'answer_count_changed':
        this.scheduleAnswerCount(sessionId);
        return;
      case 'review_list_changed':
        this.emitReviewList(state);
        return;
      case 'vote_options_shown':
        this.emitVoteOptions(state);
        return;
      case 'revealed':
        this.emitReveal(state, this.eligiblePlayerIdsOf(state));
        this.emitTypedAnswers(state);
        return;
      case 'reveal_updated':
        if (effect.scope === 'everyone') {
          // A rescore can change every eligible player's points and rank.
          this.emitReveal(state, this.eligiblePlayerIdsOf(state));
          return;
        }
        this.emitReveal(
          state,
          effect.playerId === null ? [] : [effect.playerId],
        );
        return;
      case 'typed_answers_changed':
        this.emitTypedAnswers(state);
        return;
      case 'answer_hidden':
        this.emitToRoles(
          sessionId,
          state.cursor.phase === 'review' ? ['hosts'] : ROLE_ROOMS,
          'answer:hidden',
          {
            questionId: effect.questionId,
            answerId: effect.answerId,
            optionId: effect.optionId,
          },
        );
        return;
      case 'scores_shown':
        this.emitScores(state);
        return;
      case 'podium_shown': {
        // Screen and phones see only the places revealed so far; hosts see every place (contract 6.7).
        const publicPodium = buildPodiumFrame(state, 'public');
        if (publicPodium !== null) {
          this.emitToRoles(sessionId, PUBLIC_ROOMS, 'podium', publicPodium);
        }
        const hostPodium = buildPodiumFrame(state, 'hosts');
        if (hostPodium !== null) {
          this.emitToRoles(sessionId, ['hosts'], 'podium', hostPodium);
        }
        return;
      }
      case 'state_reset':
        this.resetSessionStates(
          state,
          effect.scope === 'everyone' ? ROLE_ROOMS : ['hosts'],
        );
        return;
      case 'flags_changed':
        this.emitToRoles(
          sessionId,
          ROLE_ROOMS,
          'session:flags',
          buildSessionFlags(state),
        );
        return;
      case 'reaction':
        this.countReaction(sessionId, effect.reactionId);
        return;
      case 'player_left':
        this.unbindLeftPlayerSockets(state, effect.playerId);
        return;
      case 'player_removed':
        this.removePlayerSockets(state, effect.playerId, effect.canRejoin);
        return;
      case 'devices_changed':
        this.emitDevices(state);
        return;
      case 'timer':
        this.setPhaseTimer(sessionId, effect.phaseId, effect.fireAt);
        return;
      case 'timer_cleared':
        this.clearPhaseTimer(sessionId);
        return;
      case 'persist':
        // Queued with the command's other writes by `applyEffects`.
        return;
    }
  }

  private emitAnswerAck(
    state: QuizshowLiveState,
    playerId: string,
    questionId: string,
  ): void {
    const answer = state.current?.answers.get(playerId);
    if (answer === undefined || answer.questionId !== questionId) return;
    const myAnswer: QuizshowMyAnswer = {
      questionId: answer.questionId,
      phaseId: answer.phaseId,
      payload: answer.payload,
      receivedAt: answer.receivedAt,
    };
    this.emitToPlayer(state.sessionId, playerId, 'answer:ack', myAnswer);
  }

  private emitReviewList(state: QuizshowLiveState): void {
    const reviewList = buildReviewList(state);
    if (reviewList !== null) {
      this.emitToRoles(state.sessionId, ['hosts'], 'review:list', reviewList);
    }
    const answerCount = buildAnswerCount(state);
    if (answerCount !== null) {
      this.emitToRoles(
        state.sessionId,
        PUBLIC_ROOMS,
        'answer:count',
        answerCount,
      );
    }
  }

  /** `vote:options` per room and per player; the visible options are filtered once for every player (contract 7.1). */
  private emitVoteOptions(state: QuizshowLiveState): void {
    const { sessionId } = state;
    const play = state.current;
    const visibleOptions =
      play !== null && state.cursor.phase === 'vote'
        ? visibleVoteOptions(state, play)
        : undefined;
    const screenOptions = buildVoteOptions(state, null, visibleOptions);
    if (screenOptions !== null) {
      this.emitToRoles(sessionId, ['screen'], 'vote:options', screenOptions);
    }
    const hostOptions = buildHostVoteOptions(state);
    if (hostOptions !== null) {
      this.emitToRoles(sessionId, ['hosts'], 'vote:options', hostOptions);
    }
    for (const player of activePlayers(state)) {
      const playerOptions = buildVoteOptions(
        state,
        player.playerId,
        visibleOptions,
      );
      if (playerOptions !== null) {
        this.emitToPlayer(
          sessionId,
          player.playerId,
          'vote:options',
          playerOptions,
        );
      }
    }
  }

  private eligiblePlayerIdsOf(state: QuizshowLiveState): string[] {
    return [...(state.current?.eligiblePlayerIds ?? [])];
  }

  /**
   * `reveal` to every role room, then `reveal:mine` to each listed player
   * still eligible; one rank index, built only when a player is listed,
   * serves every player (contract 7.1).
   */
  private emitReveal(
    state: QuizshowLiveState,
    myRevealPlayerIds: readonly string[],
  ): void {
    const reveal = buildReveal(state);
    if (reveal !== null) {
      this.emitToRoles(state.sessionId, ROLE_ROOMS, 'reveal', reveal);
    }
    if (myRevealPlayerIds.length === 0) return;
    const rankIndex = buildRankIndex(state);
    for (const playerId of myRevealPlayerIds) {
      const myReveal = buildMyReveal(state, playerId, rankIndex);
      if (myReveal !== null) {
        this.emitToPlayer(state.sessionId, playerId, 'reveal:mine', myReveal);
      }
    }
  }

  /** `typed:answers` to hosts while a type_answer question is revealed (contract 6.4 rule 6). */
  private emitTypedAnswers(state: QuizshowLiveState): void {
    const typedAnswers = buildTypedAnswers(state);
    if (typedAnswers !== null) {
      this.emitToRoles(
        state.sessionId,
        ['hosts'],
        'typed:answers',
        typedAnswers,
      );
    }
  }

  /**
   * `scores` per room (the public one leaves out unrevealed podium places,
   * contract 6.7), then `scores:mine` to each player whose place is shown;
   * one rank index serves every frame (contract 7.1).
   */
  private emitScores(state: QuizshowLiveState): void {
    const rankIndex = buildRankIndex(state);
    const publicScores = buildScores(state, rankIndex, 'public');
    if (publicScores !== null) {
      this.emitToRoles(state.sessionId, PUBLIC_ROOMS, 'scores', publicScores);
    }
    const hostScores = buildScores(state, rankIndex, 'hosts');
    if (hostScores !== null) {
      this.emitToRoles(state.sessionId, ['hosts'], 'scores', hostScores);
    }
    for (const player of activePlayers(state)) {
      const myScores = buildMyScores(state, player.playerId, rankIndex);
      if (myScores !== null) {
        this.emitToPlayer(
          state.sessionId,
          player.playerId,
          'scores:mine',
          myScores,
        );
      }
    }
  }

  /**
   * Tells the removed player's sockets whether they may join again. A removal
   * that allows a rejoin unbinds them like a leave (contract 6.14): they stay
   * in the players room, so the join form works and a rejoin on the same
   * socket is accepted. Any other removal takes them out of every room of
   * the session.
   *
   * A player who left first has sockets outside the private room: a leave
   * unbinds them and they stay in the players room. A removal for good also
   * finds those by member (player-role sockets of this session whose member
   * is the player's), tells them `player:removed` and takes them out of
   * every role room, so a removed phone stops reading the public frames.
   */
  private removePlayerSockets(
    state: QuizshowLiveState,
    playerId: string,
    canRejoin: boolean,
  ): void {
    const { sessionId } = state;
    const playerRoom = quizshowPlayerRoomName(sessionId, playerId);
    const payload = { sessionId, canRejoin };
    const privateRoomSocketIds = new Set(
      this.socketsInRoom(playerRoom).map((socket) => socket.id),
    );
    this.emitToRoom(playerRoom, 'player:removed', payload);
    if (canRejoin) {
      this.unbindPlayerSockets(state, playerId, [
        playerRoom,
        quizshowRoomName(sessionId, 'screen'),
        quizshowRoomName(sessionId, 'hosts'),
      ]);
      return;
    }
    const roleRooms = ROLE_ROOMS.map((role) =>
      quizshowRoomName(sessionId, role),
    );
    this.namespace?.in(playerRoom).socketsLeave([...roleRooms, playerRoom]);
    const userId = state.players.get(playerId)?.userId;
    if (userId === undefined) return;
    for (const socket of this.namespace?.sockets.values() ?? []) {
      const data = socket.data as QuizshowRuntimeSocketData | undefined;
      if (
        privateRoomSocketIds.has(socket.id) ||
        data?.sessionId !== sessionId ||
        data.userId !== userId ||
        data.role !== 'player'
      ) {
        continue;
      }
      socket.emit('player:removed', payload);
      for (const room of roleRooms) void socket.leave(room);
    }
  }

  /** The player left (contract 6.14): their sockets leave the private room and stay in the players room. */
  private unbindLeftPlayerSockets(
    state: QuizshowLiveState,
    playerId: string,
  ): void {
    this.unbindPlayerSockets(state, playerId, [
      quizshowPlayerRoomName(state.sessionId, playerId),
    ]);
  }

  /**
   * Each socket of the player leaves the listed rooms, stops counting for
   * them and gets a fresh player `session:state` with `me` null, so the
   * phone shows the join form again. The suggested name is the one they
   * played under, ready for a rejoin.
   */
  private unbindPlayerSockets(
    state: QuizshowLiveState,
    playerId: string,
    roomsToLeave: readonly string[],
  ): void {
    const { sessionId } = state;
    const suggestedScreenName = state.players.get(playerId)?.screenName ?? '';
    for (const socket of this.socketsOfPlayer(sessionId, playerId)) {
      for (const room of roomsToLeave) void socket.leave(room);
      const data = socket.data as QuizshowRuntimeSocketData;
      // Counted once per socket: only a socket still bound to the player detaches.
      if (data.playerId === playerId) {
        data.playerId = null;
        this.noteSocketDetached(sessionId, playerId);
      }
      this.emitSessionState(socket, state, {
        role: 'player',
        playerId: null,
        suggestedScreenName,
      });
    }
  }

  /**
   * A fresh `session:state` to every socket in the listed role rooms, each
   * for its role: after a lobby refresh every role (contract 6.10), after a
   * guest push the hosts only.
   */
  private resetSessionStates(
    state: QuizshowLiveState,
    roles: readonly QuizshowRoleRoom[],
  ): void {
    for (const role of roles) {
      const room = quizshowRoomName(state.sessionId, role);
      for (const socket of this.socketsInRoom(room)) {
        this.emitSessionState(
          socket,
          state,
          this.viewerOf(state, role, socket),
        );
      }
    }
  }

  private viewerOf(
    state: QuizshowLiveState,
    role: QuizshowRoleRoom,
    socket: Socket,
  ): QuizshowSessionStateViewer {
    if (role === 'screen') return { role: 'screen' };
    if (role === 'hosts') return { role: 'host' };
    const playerId =
      (socket.data as QuizshowRuntimeSocketData | undefined)?.playerId ?? null;
    const player = playerId === null ? undefined : state.players.get(playerId);
    return {
      role: 'player',
      playerId,
      suggestedScreenName: player?.screenName ?? '',
    };
  }

  /**
   * The player's sockets on this server: those in the private room, plus any
   * whose bind is still joining that room (its data already names the
   * player).
   */
  private socketsOfPlayer(sessionId: string, playerId: string): Socket[] {
    const sockets = new Set(
      this.socketsInRoom(quizshowPlayerRoomName(sessionId, playerId)),
    );
    for (const socket of this.namespace?.sockets.values() ?? []) {
      const data = socket.data as QuizshowRuntimeSocketData | undefined;
      if (data?.sessionId === sessionId && data.playerId === playerId) {
        sockets.add(socket);
      }
    }
    return [...sockets];
  }

  /** This server's sockets in one room, copied so a socket may leave it while the caller loops. */
  private socketsInRoom(room: string): Socket[] {
    const namespace = this.namespace;
    const socketIds = namespace?.adapter.rooms.get(room);
    if (namespace === null || socketIds === undefined) return [];
    return [...socketIds].flatMap((socketId) => {
      const socket = namespace.sockets.get(socketId);
      return socket === undefined ? [] : [socket];
    });
  }

  /** `devices:update` to hosts with every pairing the remote lists. */
  private emitDevices(state: QuizshowLiveState): void {
    this.emitToRoles(state.sessionId, ['hosts'], 'devices:update', {
      devices: buildPairedDevices(state),
    });
  }

  /**
   * Moves a live pairing's socket count, floored at 0, and tells hosts when
   * it changed; an unknown session, an unknown pairing or a revoked one does
   * nothing.
   */
  private moveDeviceSocketCount(
    sessionId: string,
    pairingId: string,
    step: 1 | -1,
  ): void {
    const state = this.liveStates.get(sessionId);
    const device = state?.pairedDevices.find(
      (pairedDevice) => pairedDevice.pairingId === pairingId,
    );
    if (state === undefined || device === undefined) return;
    if (device.revokedAt !== null) return;
    const connectedSocketCount = Math.max(
      device.connectedSocketCount + step,
      0,
    );
    if (connectedSocketCount === device.connectedSocketCount) return;
    device.connectedSocketCount = connectedSocketCount;
    this.emitDevices(state);
  }

  /** Adds one reaction to the session's window and makes sure a `reactions` frame follows (contract 6.19). */
  private countReaction(
    sessionId: string,
    reactionId: QuizshowReactionId,
  ): void {
    let counts = this.reactionCounts.get(sessionId);
    if (counts === undefined) {
      counts = new Map<QuizshowReactionId, number>();
      this.reactionCounts.set(sessionId, counts);
    }
    counts.set(reactionId, (counts.get(reactionId) ?? 0) + 1);
    this.scheduleThrottled(
      this.reactionThrottles,
      sessionId,
      QUIZSHOW_LIMITS.reactionsFrameMs,
      () => this.emitReactions(sessionId),
    );
  }

  /** `reactions` to screen and hosts with the window's counts, then a new window starts. */
  private emitReactions(sessionId: string): void {
    const counts = this.reactionCounts.get(sessionId);
    this.reactionCounts.delete(sessionId);
    if (counts === undefined) return;
    const frame: QuizshowReactionsFrame = { counts: {} };
    for (const [reactionId, count] of counts) {
      if (count > 0) frame.counts[reactionId] = count;
    }
    if (Object.keys(frame.counts).length === 0) return;
    this.emitToRoles(sessionId, ['screen', 'hosts'], 'reactions', frame);
  }

  /** Drops the state and its timers at once, then waits for the session's writes; a load in between waits too. */
  private async endSession(state: QuizshowLiveState): Promise<void> {
    const { sessionId } = state;
    this.clearSessionTimers(sessionId);
    if (this.liveStates.get(sessionId) === state) {
      this.liveStates.delete(sessionId);
    }
    await this.trackEnding(sessionId, this.persistence.flush(sessionId));
  }

  private clearSessionTimers(sessionId: string): void {
    this.clearPhaseTimer(sessionId);
    for (const throttles of [
      this.lobbyThrottles,
      this.answerCountThrottles,
      this.reactionThrottles,
    ]) {
      const throttle = throttles.get(sessionId);
      if (throttle !== undefined) clearTimeout(throttle);
      throttles.delete(sessionId);
    }
    this.reactionCounts.delete(sessionId);
  }

  /** One phase timer per session: a new one replaces the old. */
  private setPhaseTimer(
    sessionId: string,
    phaseId: string,
    fireAt: number,
  ): void {
    this.clearPhaseTimer(sessionId);
    const timer = setTimeout(
      () => {
        if (this.phaseTimers.get(sessionId) === timer) {
          this.phaseTimers.delete(sessionId);
        }
        void this.execute(sessionId, (state, now) =>
          succeed<Record<string, never>>(
            {},
            timerElapsed(state, phaseId, now, this.random),
          ),
        ).catch((error: unknown) => {
          this.logger.error(
            `Pulse Live timer failed for session ${sessionId}: ${quizshowWriteFailureCode(error)}`,
          );
        });
      },
      Math.max(fireAt - Date.now(), 0),
    );
    timer.unref();
    this.phaseTimers.set(sessionId, timer);
  }

  private clearPhaseTimer(sessionId: string): void {
    const timer = this.phaseTimers.get(sessionId);
    if (timer !== undefined) clearTimeout(timer);
    this.phaseTimers.delete(sessionId);
  }

  /** Trailing throttle: the first change in a window schedules one frame built from the state when it fires. */
  private scheduleThrottled(
    throttles: Map<string, QuizshowTimerHandle>,
    sessionId: string,
    delayMs: number,
    emitFrames: (state: QuizshowLiveState) => void,
  ): void {
    if (throttles.has(sessionId)) return;
    const throttle = setTimeout(() => {
      throttles.delete(sessionId);
      const state = this.liveStates.get(sessionId);
      if (state === undefined) return;
      try {
        emitFrames(state);
      } catch (error: unknown) {
        this.logger.error(
          `Pulse Live throttled frame failed for session ${sessionId}: ${quizshowWriteFailureCode(error)}`,
        );
      }
    }, delayMs);
    throttle.unref();
    throttles.set(sessionId, throttle);
  }

  private scheduleLobbyUpdate(sessionId: string): void {
    this.scheduleThrottled(
      this.lobbyThrottles,
      sessionId,
      QUIZSHOW_LOBBY_THROTTLE_MS,
      (state) => {
        this.emitToRoles(
          sessionId,
          ['screen'],
          'lobby:update',
          buildLobby(state, 'screen'),
        );
        this.emitToRoles(
          sessionId,
          ['players'],
          'lobby:update',
          buildPlayerLobby(state),
        );
        this.emitToRoles(
          sessionId,
          ['hosts'],
          'lobby:update',
          buildHostLobby(state),
        );
      },
    );
  }

  private scheduleAnswerCount(sessionId: string): void {
    this.scheduleThrottled(
      this.answerCountThrottles,
      sessionId,
      QUIZSHOW_ANSWER_COUNT_THROTTLE_MS,
      (state) => {
        const answerCount = buildAnswerCount(state);
        if (answerCount === null) return;
        // Phones show "9 of 14 answered" too (contract 6.21).
        this.emitToRoles(sessionId, ROLE_ROOMS, 'answer:count', answerCount);
      },
    );
  }

  private emitToRoles(
    sessionId: string,
    roles: readonly QuizshowRoleRoom[],
    event: string,
    payload: unknown,
  ): void {
    for (const role of roles) {
      this.emitToRoom(quizshowRoomName(sessionId, role), event, payload);
    }
  }

  private emitToPlayer(
    sessionId: string,
    playerId: string,
    event: string,
    payload: unknown,
  ): void {
    this.emitToRoom(
      quizshowPlayerRoomName(sessionId, playerId),
      event,
      payload,
    );
  }

  private emitToRoom(room: string, event: string, payload: unknown): void {
    this.namespace?.to(room).emit(event, payload);
  }
}
