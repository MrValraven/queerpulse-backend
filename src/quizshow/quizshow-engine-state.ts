/**
 * Pulse Live (`quizshow`) engine state helpers: building the lobby state,
 * moving the cursor, reading who plays and building command outcomes. Pure:
 * every time comes in as a `now` argument.
 */
import {
  QUIZSHOW_LIMITS,
  type QuizshowAckFailure,
  type QuizshowErrorCode,
  type QuizshowMe,
  type QuizshowPhase,
  type QuizshowSessionStatus,
  type QuizshowTeamColorKey,
} from './quizshow.contract';
import { quizshowAckFailure } from './quizshow-errors';
import { competitionRanks } from './quizshow-scoring';
import { emptyWheelProgress, progressCursorFields } from './quizshow-wheel';
import type {
  QuizshowCommandOutcome,
  QuizshowEngineEffect,
  QuizshowLivePlayer,
  QuizshowLiveState,
  QuizshowLiveTeam,
  QuizshowPersistOperation,
} from './quizshow-engine-types';

/** What the runtime knows when a session opens; the engine fills the rest. */
export type QuizshowLobbyStateInput = Omit<
  QuizshowLiveState,
  | 'status'
  | 'cursor'
  | 'phaseCounter'
  | 'pausedAt'
  | 'lastTransition'
  | 'players'
  | 'teams'
  | 'current'
  | 'questionLog'
  | 'scoresAtLastFrame'
  | 'lastScoresFrame'
  | 'podium'
  | 'hasScoredQuestion'
  | 'lastHostCommandAt'
  | 'isScreenMuted'
  | 'wheelProgress'
  | 'isJoinLocked'
  | 'isAutoAdvanceOn'
  | 'pairedDevices'
  | 'guestPushSentAt'
  | 'giving'
  | 'adjustRequestIds'
  | 'correctedQuestionIds'
> & { startedAt: number };

export interface QuizshowCursorAdvance {
  phase: QuizshowPhase;
  roundIndex: number | null;
  questionIndex: number | null;
  now: number;
  durationMs: number | null;
  extraTimeMs: number | null;
}

export interface QuizshowEntrantTotal {
  entrantId: string;
  kind: 'player' | 'team';
  name: string;
  colorKey: QuizshowTeamColorKey | null;
  score: number;
}

/** A fresh session in the lobby at phase id `'0'`, the abandonment clock started at `startedAt`. */
export function createLobbyState(
  input: QuizshowLobbyStateInput,
): QuizshowLiveState {
  const { startedAt, attachedOrganiserUserIds, ...sessionFields } = input;
  const wheelProgress = emptyWheelProgress();
  return {
    ...sessionFields,
    status: 'lobby',
    cursor: {
      phaseId: '0',
      status: 'lobby',
      phase: 'lobby',
      roundIndex: null,
      questionIndex: null,
      phaseStartedAt: null,
      deadline: null,
      extraTimeDeadline: null,
      pausedRemainingMs: null,
      pausedExtraTimeRemainingMs: null,
      isRestartRecovery: false,
      talkStartsAt: null,
      autoAdvanceAt: null,
      podiumRevealedCount: null,
      ...progressCursorFields(input.snapshot.rounds, wheelProgress, 'lobby'),
    },
    wheelProgress,
    phaseCounter: 0,
    pausedAt: null,
    lastHostCommandAt: startedAt,
    lastTransition: null,
    players: new Map(),
    teams: new Map(),
    current: null,
    questionLog: [],
    scoresAtLastFrame: new Map(),
    lastScoresFrame: null,
    podium: null,
    attachedOrganiserUserIds: new Set(attachedOrganiserUserIds),
    hasScoredQuestion: false,
    isScreenMuted: false,
    isJoinLocked: false,
    isAutoAdvanceOn: false,
    pairedDevices: [],
    guestPushSentAt: null,
    giving: null,
    adjustRequestIds: [],
    correctedQuestionIds: new Set(),
  };
}

/**
 * Moves to the next phase: a new phase id, the transition it came from, fresh
 * deadlines, no paused remainder, the session status copied in and the four
 * progress fields recomputed. Callers change `wheelProgress` first and call
 * this last, so the fields see the new progress. The talk, auto-advance and
 * podium fields belong to one phase each, so every transition clears them;
 * the talk, auto-advance and podium callers set them right after this call.
 */
export function advanceCursor(
  state: QuizshowLiveState,
  next: QuizshowCursorAdvance,
): void {
  const fromPhaseId = state.cursor.phaseId;
  state.phaseCounter += 1;
  const toPhaseId = String(state.phaseCounter);
  state.lastTransition = { fromPhaseId, toPhaseId };
  state.cursor = {
    ...state.cursor,
    phaseId: toPhaseId,
    phase: next.phase,
    roundIndex: next.roundIndex,
    questionIndex: next.questionIndex,
    phaseStartedAt: next.now,
    deadline: next.durationMs === null ? null : next.now + next.durationMs,
    extraTimeDeadline:
      next.extraTimeMs === null ? null : next.now + next.extraTimeMs,
    pausedRemainingMs: null,
    pausedExtraTimeRemainingMs: null,
    isRestartRecovery: false,
    talkStartsAt: null,
    autoAdvanceAt: null,
    podiumRevealedCount: null,
    ...progressCursorFields(
      state.snapshot.rounds,
      state.wheelProgress,
      next.phase,
    ),
  };
  state.cursor.status = state.status;
}

/** Sets the session status and the cursor status together, for pause, resume, finish and abandon. */
export function setSessionStatus(
  state: QuizshowLiveState,
  status: QuizshowSessionStatus,
): void {
  state.status = status;
  state.cursor.status = status;
}

/** Why a command that needs `required` cannot run in the session's status (contract 3.1). */
export function statusRefusalCode(
  status: QuizshowSessionStatus,
  required: 'lobby' | 'running' | 'open',
): QuizshowErrorCode {
  if (status === 'finished' || status === 'abandoned') {
    return 'quizshow_session_ended';
  }
  if (required === 'lobby') return 'quizshow_already_started';
  if (status === 'lobby') return 'quizshow_session_not_started';
  return 'quizshow_session_paused'; // required 'running', status 'paused'
}

/** Still playing: neither removed by a host nor gone with a leave (contract 6.14). */
export function isActivePlayer(
  player: Pick<QuizshowLivePlayer, 'removedAt' | 'leftAt'>,
): boolean {
  return player.removedAt === null && player.leftAt === null;
}

/**
 * No socket connected for at least `awayAfterMs` (contract 6.2). A player who
 * never disconnected, or whose last socket left moments ago, still counts as
 * here, so a quick reload does not cost them a question.
 */
export function isAwayAt(
  player: Pick<QuizshowLivePlayer, 'connectedSocketCount' | 'disconnectedAt'>,
  now: number,
): boolean {
  return (
    player.connectedSocketCount === 0 &&
    player.disconnectedAt !== null &&
    now - player.disconnectedAt >= QUIZSHOW_LIMITS.awayAfterMs
  );
}

/** Players still in the session, in joined order. */
export function activePlayers(state: QuizshowLiveState): QuizshowLivePlayer[] {
  return [...state.players.values()]
    .filter(isActivePlayer)
    .sort((first, second) => first.joinedAt - second.joinedAt);
}

/** Players eligible for the current question who are still in the session, in joined order; [] with no current question. */
export function eligiblePlayersNow(
  state: QuizshowLiveState,
): QuizshowLivePlayer[] {
  const current = state.current;
  if (current === null) return [];
  return activePlayers(state).filter((player) =>
    current.eligiblePlayerIds.has(player.playerId),
  );
}

/** The player had a place in the current question when it opened. */
export function isEligible(
  state: QuizshowLiveState,
  playerId: string,
): boolean {
  return state.current?.eligiblePlayerIds.has(playerId) ?? false;
}

/** The deadline the player answers against: the extra-time one when the question gave them extra time. */
export function ownDeadline(
  state: QuizshowLiveState,
  playerId: string,
): number | null {
  const hasExtraTime = state.current?.extraTimePlayerIds.has(playerId) ?? false;
  return hasExtraTime ? state.cursor.extraTimeDeadline : state.cursor.deadline;
}

function teamOf(
  state: QuizshowLiveState,
  player: QuizshowLivePlayer,
): QuizshowLiveTeam | null {
  if (player.teamId === null) return null;
  return state.teams.get(player.teamId) ?? null;
}

/** The joker that counts for the player: their own in solo play, their team's in teams play. */
function jokerHolderOf(
  state: QuizshowLiveState,
  player: QuizshowLivePlayer,
): Pick<QuizshowLivePlayer, 'hasUsedJoker' | 'jokerRoundIndex'> | null {
  if (state.playMode === 'solo') return player;
  return teamOf(state, player);
}

/** The player's joker (solo) or their team's joker (teams) doubles this round. */
export function isJokerActiveFor(
  state: QuizshowLiveState,
  playerId: string,
  roundIndex: number,
): boolean {
  const player = state.players.get(playerId);
  if (player === undefined) return false;
  const holder = jokerHolderOf(state, player);
  return holder !== null && holder.jokerRoundIndex === roundIndex;
}

/** Who competes: active players in solo play, teams in teams play (created order); a team keeps its score when members leave. */
export function entrantTotals(
  state: QuizshowLiveState,
): QuizshowEntrantTotal[] {
  if (state.playMode === 'solo') {
    return activePlayers(state).map((player): QuizshowEntrantTotal => ({
      entrantId: player.playerId,
      kind: 'player',
      name: player.screenName,
      colorKey: null,
      score: player.score,
    }));
  }
  return [...state.teams.values()]
    .sort((first, second) => first.createdAt - second.createdAt)
    .map((team): QuizshowEntrantTotal => ({
      entrantId: team.teamId,
      kind: 'team',
      name: team.name,
      colorKey: team.colorKey,
      score: team.score,
    }));
}

/** Every entrant with its competition rank, sorted once, and an id lookup into it (contract 7.1). */
export interface QuizshowRankIndex {
  ranked: ReadonlyArray<QuizshowEntrantTotal & { rank: number }>;
  rankByEntrantId: ReadonlyMap<string, number>;
}

/**
 * One `competitionRanks` sort for a whole frame batch, so building a frame per
 * player reads ranks from the map. Phases and frames both use it; frames
 * re-exports it under the contract's import path.
 */
export function buildRankIndex(state: QuizshowLiveState): QuizshowRankIndex {
  const ranked = competitionRanks(entrantTotals(state));
  const rankByEntrantId = new Map<string, number>();
  for (const entry of ranked) rankByEntrantId.set(entry.entrantId, entry.rank);
  return { ranked, rankByEntrantId };
}

/** The entrant's rank; an unknown or null id ranks after every entrant. */
export function rankOf(
  index: QuizshowRankIndex,
  entrantId: string | null,
): number {
  const lastRank = index.ranked.length + 1;
  if (entrantId === null) return lastRank;
  return index.rankByEntrantId.get(entrantId) ?? lastRank;
}

/** The distinct podium places, revealed in the order 3, 2, 1 (contract 6.7). */
export function podiumSteps(
  state: Pick<QuizshowLiveState, 'podium'>,
): Array<1 | 2 | 3> {
  const places = new Set((state.podium ?? []).map((entry) => entry.place));
  return ([3, 2, 1] as const).filter((place) => places.has(place));
}

/** Places shown so far while the phase is podium; null in every other phase (nothing withheld). */
export function revealedPodiumPlaces(
  state: QuizshowLiveState,
): ReadonlySet<number> | null {
  if (state.cursor.phase !== 'podium') return null;
  const steps = podiumSteps(state);
  const revealedCount = state.cursor.podiumRevealedCount ?? steps.length;
  return new Set<number>(steps.slice(0, revealedCount));
}

/** The player's own `me` frame; the joker fields are the team's in teams play. */
export function toMe(state: QuizshowLiveState, playerId: string): QuizshowMe {
  const player = state.players.get(playerId);
  if (player === undefined) {
    throw new Error(`Pulse Live player ${playerId} is not in the session.`);
  }
  const holder = jokerHolderOf(state, player);
  return {
    playerId: player.playerId,
    screenName: player.screenName,
    isAvatarShown: player.isAvatarShown,
    hasExtraTime: player.hasExtraTime,
    teamId: player.teamId,
    isCohostPlayer: player.isCohostPlayer,
    score: player.score,
    streak: player.streak,
    hasUsedJoker: holder?.hasUsedJoker ?? false,
    jokerRoundIndex: holder?.jokerRoundIndex ?? null,
  };
}

/** Wraps a persistence operation as an effect for the runtime's write queue. */
export function persist(
  operation: QuizshowPersistOperation,
): QuizshowEngineEffect {
  return { kind: 'persist', operation };
}

/** A command that acted, with what it hands the caller and the runtime. */
export function succeed<Success extends object>(
  success: Success,
  effects: QuizshowEngineEffect[],
): QuizshowCommandOutcome<Success> {
  return { ok: true, success, effects };
}

/**
 * A refused command; with `withCursor` the ack carries a copy of the current
 * cursor, and `extra` adds a suggested screen name to a name refusal.
 */
export function refuse<Success extends object = Record<string, never>>(
  code: QuizshowErrorCode,
  state: QuizshowLiveState,
  withCursor: boolean,
  extra?: Pick<QuizshowAckFailure, 'suggestedScreenName'>,
): QuizshowCommandOutcome<Success> {
  const failure = withCursor
    ? quizshowAckFailure(code, { ...state.cursor }, extra)
    : quizshowAckFailure(code, undefined, extra);
  return { ok: false, failure, effects: [] };
}

/** Remembers an organiser who attached a screen or remote; a known id succeeds with no effects. */
export function recordAttachedOrganiser(
  state: QuizshowLiveState,
  userId: string,
): QuizshowCommandOutcome {
  if (state.attachedOrganiserUserIds.has(userId)) {
    return succeed<Record<string, never>>({}, []);
  }
  state.attachedOrganiserUserIds.add(userId);
  return succeed<Record<string, never>>({}, [
    persist({ type: 'add_attached_organiser', userId }),
  ]);
}
