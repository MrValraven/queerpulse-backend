/**
 * Pulse Live (`quizshow`) engine, the host roster commands: teams a host
 * makes for the tables, renaming a player and moving a player to another
 * team (contract 4.3, 6.11, 6.13, 6.14). Pure: every time comes in as a `now`
 * argument and every id from the injected `QuizshowRandom`. This module never
 * imports the phases module, so it records host presence with its own two
 * lines that match `noteHostCommand` and `hostActed` there.
 */
import {
  QUIZSHOW_LIMITS,
  QUIZSHOW_TEAM_COLOR_KEYS,
  type QuizshowErrorCode,
  type QuizshowPhase,
  type QuizshowTeamColorKey,
} from './quizshow.contract';
import {
  buildTeam,
  dropEmptyLobbyTeams,
  foldNameKey,
  isTeamFull,
  screenNameRefusal,
  textRefusal,
} from './quizshow-engine-players';
import {
  persist,
  refuse,
  statusRefusalCode,
  succeed,
} from './quizshow-engine-state';
import type {
  QuizshowCommandOutcome,
  QuizshowEngineEffect,
  QuizshowLivePlayer,
  QuizshowLiveState,
  QuizshowLiveTeam,
} from './quizshow-engine-types';
import type { QuizshowRandom } from './quizshow-snapshot';

/** The same shape as `QuizshowHostOutcome` in the phases module, declared here so this module stays free of that import. */
type QuizshowRosterHostOutcome = QuizshowCommandOutcome<{ isNoop: boolean }>;

type QuizshowCreateTeamsOutcome = QuizshowCommandOutcome<{
  isNoop: boolean;
  teamIds: string[];
}>;

/**
 * A host may not move a player while a question is asked, answered, voted on,
 * revealed or scored (contract 6.14, amended in 13): a rescore, hide or
 * favourite in reveal or scores recomputes that question's team points from
 * each player's current team, so a move there would hand them to the new team.
 */
const QUESTION_PHASES: readonly QuizshowPhase[] = [
  'read',
  'open',
  'write',
  'review',
  'vote',
  'reveal',
  'scores',
];

function isOpenStatus(state: QuizshowLiveState): boolean {
  return (
    state.status === 'lobby' ||
    state.status === 'running' ||
    state.status === 'paused'
  );
}

/** Every host command attempt, refused or not, resets the abandonment clock: it measures host presence. */
function noteHostCommand(state: QuizshowLiveState, now: number): void {
  state.lastHostCommandAt = now;
}

/** A roster command that acted or was a no-op ends on one checkpoint, as every host command does. */
function withCheckpoint(
  effects: QuizshowEngineEffect[],
): QuizshowEngineEffect[] {
  return [...effects, persist({ type: 'checkpoint' })];
}

type RosterPlayerLookup =
  | { player: QuizshowLivePlayer; refusal: null }
  | { player: null; refusal: QuizshowErrorCode };

/** The target of a host roster command: unknown and removed players are not found, a player who left is named as such. */
function lookUpRosterPlayer(
  state: QuizshowLiveState,
  playerId: string,
): RosterPlayerLookup {
  const player = state.players.get(playerId);
  if (player === undefined || player.removedAt !== null) {
    return { player: null, refusal: 'quizshow_player_not_found' };
  }
  if (player.leftAt !== null) {
    return { player: null, refusal: 'quizshow_player_left' };
  }
  return { player, refusal: null };
}

/** The first keys of `QUIZSHOW_TEAM_COLOR_KEYS`, in order, that no team holds; null when fewer than `count` are free. */
function freeColorKeys(
  state: QuizshowLiveState,
  count: number,
): QuizshowTeamColorKey[] | null {
  const heldColorKeys = new Set(
    [...state.teams.values()].map((team) => team.colorKey),
  );
  const freeKeys = QUIZSHOW_TEAM_COLOR_KEYS.filter(
    (colorKey) => !heldColorKeys.has(colorKey),
  ).slice(0, count);
  return freeKeys.length === count ? freeKeys : null;
}

/**
 * `host:createTeams` (contract 6.11): lobby and teams play only. Every name is
 * trimmed and checked, and the names must be unique among themselves and the
 * existing teams by `foldNameKey`. All or nothing: one refused name creates no
 * team. The new teams take the first free colour keys and stay when they are
 * empty, since a host made them for the tables.
 */
export function hostCreateTeams(
  state: QuizshowLiveState,
  names: string[],
  now: number,
  random: QuizshowRandom,
): QuizshowCreateTeamsOutcome {
  noteHostCommand(state, now);
  if (state.status !== 'lobby') {
    return refuse('quizshow_not_in_lobby', state, true);
  }
  if (state.playMode === 'solo') {
    return refuse('quizshow_teams_off', state, false);
  }
  const trimmedNames = names.map((name) => name.trim());
  for (const trimmedName of trimmedNames) {
    const nameRefusal = textRefusal(trimmedName);
    if (nameRefusal !== null) return refuse(nameRefusal, state, false);
  }
  const takenNameKeys = new Set(
    [...state.teams.values()].map((team) => foldNameKey(team.name)),
  );
  for (const trimmedName of trimmedNames) {
    const nameKey = foldNameKey(trimmedName);
    if (takenNameKeys.has(nameKey)) {
      return refuse('quizshow_team_name_taken', state, false);
    }
    takenNameKeys.add(nameKey);
  }
  if (
    state.teams.size + trimmedNames.length >
    QUIZSHOW_LIMITS.teamsPerSessionMax
  ) {
    return refuse('quizshow_team_limit', state, false);
  }
  if (trimmedNames.length === 0) {
    return succeed({ isNoop: true, teamIds: [] }, withCheckpoint([]));
  }
  const colorKeys = freeColorKeys(state, trimmedNames.length);
  // The limit check above leaves a free key per team; this guards a state whose teams share keys.
  if (colorKeys === null) return refuse('quizshow_team_limit', state, false);

  const newTeams: QuizshowLiveTeam[] = [];
  for (const [nameIndex, trimmedName] of trimmedNames.entries()) {
    const colorKey = colorKeys[nameIndex];
    if (colorKey === undefined) {
      return refuse('quizshow_team_limit', state, false);
    }
    newTeams.push(buildTeam(trimmedName, colorKey, now, random, true));
  }
  const effects: QuizshowEngineEffect[] = [];
  for (const team of newTeams) {
    state.teams.set(team.teamId, team);
    effects.push(persist({ type: 'insert_team', team: { ...team } }));
  }
  effects.push({ kind: 'lobby_changed' });
  return succeed(
    { isNoop: false, teamIds: newTeams.map((team) => team.teamId) },
    withCheckpoint(effects),
  );
}

/**
 * `host:renamePlayer` (contract 6.13, 6.14): any open status, an active
 * player, the text checks and a screen name no other player of the session
 * holds. The same name is a no-op.
 */
export function hostRenamePlayer(
  state: QuizshowLiveState,
  playerId: string,
  screenName: string,
  now: number,
): QuizshowRosterHostOutcome {
  noteHostCommand(state, now);
  if (!isOpenStatus(state)) {
    return refuse(statusRefusalCode(state.status, 'open'), state, true);
  }
  const lookup = lookUpRosterPlayer(state, playerId);
  if (lookup.player === null) return refuse(lookup.refusal, state, false);
  const player = lookup.player;
  const trimmedName = screenName.trim();
  const nameRefusal = textRefusal(trimmedName);
  if (nameRefusal !== null) return refuse(nameRefusal, state, false);
  const takenRefusal = screenNameRefusal(state, trimmedName, playerId);
  // The players module builds this refusal with its suggestion; the ack passes it on as it is.
  if (takenRefusal !== null && !takenRefusal.ok) {
    return { ok: false, failure: takenRefusal.failure, effects: [] };
  }
  if (trimmedName === player.screenName) {
    return succeed({ isNoop: true }, withCheckpoint([]));
  }
  player.screenName = trimmedName;
  return succeed(
    { isNoop: false },
    withCheckpoint([
      persist({
        type: 'update_player',
        playerId,
        fields: { screenName: trimmedName },
      }),
      { kind: 'lobby_changed' },
      { kind: 'me_changed', playerIds: [playerId] },
    ]),
  );
}

/**
 * `host:movePlayer` (contract 6.14): teams play, any open status, an active
 * player and a team with room, outside the question phases (reveal and scores
 * count as question phases here). In the lobby the
 * old team goes when the move empties it, unless a host made it. Points the
 * player won before stay with the old team.
 */
export function hostMovePlayer(
  state: QuizshowLiveState,
  playerId: string,
  teamId: string,
  now: number,
): QuizshowRosterHostOutcome {
  noteHostCommand(state, now);
  if (state.playMode === 'solo') {
    return refuse('quizshow_teams_off', state, false);
  }
  if (!isOpenStatus(state)) {
    return refuse(statusRefusalCode(state.status, 'open'), state, true);
  }
  const lookup = lookUpRosterPlayer(state, playerId);
  if (lookup.player === null) return refuse(lookup.refusal, state, false);
  const player = lookup.player;
  const team = state.teams.get(teamId);
  if (team === undefined) {
    return refuse('quizshow_team_not_found', state, false);
  }
  if (QUESTION_PHASES.includes(state.cursor.phase)) {
    return refuse('quizshow_move_during_question', state, true);
  }
  if (player.teamId === team.teamId) {
    return succeed({ isNoop: true }, withCheckpoint([]));
  }
  if (isTeamFull(state, team.teamId)) {
    return refuse('quizshow_team_full', state, false);
  }
  const leftTeamId = player.teamId;
  player.teamId = team.teamId;
  // The player row moves first: the dropped team's row is deleted after nothing points at it.
  return succeed(
    { isNoop: false },
    withCheckpoint([
      persist({
        type: 'update_player',
        playerId,
        fields: { teamId: team.teamId },
      }),
      ...dropEmptyLobbyTeams(state, [leftTeamId]),
      { kind: 'lobby_changed' },
      { kind: 'me_changed', playerIds: [playerId] },
    ]),
  );
}
