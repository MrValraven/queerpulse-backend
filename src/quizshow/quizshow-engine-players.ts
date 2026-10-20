/**
 * Pulse Live (`quizshow`) engine, the player commands: joining the lobby,
 * names, teams, settings, the joker, answers and votes. Pure: every time comes
 * in as a `now` argument and every id from the injected `QuizshowRandom`.
 */
import { textHasBlockedTerm } from '../common/blocked-terms';
import {
  QUIZSHOW_LIMITS,
  type QuizshowAnswerPayload,
  type QuizshowErrorCode,
  type QuizshowMe,
  type QuizshowMyAnswer,
  type QuizshowMyVote,
  type QuizshowOption,
  type QuizshowPhase,
  type QuizshowTeamColorKey,
} from './quizshow.contract';
import { isTypedAnswerMatch } from './quizshow-answer-normaliser';
import {
  activePlayers,
  isEligible,
  ownDeadline,
  persist,
  refuse,
  succeed,
  toMe,
} from './quizshow-engine-state';
import type {
  QuizshowCommandOutcome,
  QuizshowEngineEffect,
  QuizshowLiveAnswer,
  QuizshowLivePlayer,
  QuizshowLiveQuestionPlay,
  QuizshowLiveState,
  QuizshowLiveTeam,
  QuizshowLiveVote,
  QuizshowPersistOperation,
} from './quizshow-engine-types';
import {
  snapshotQuestionAt,
  type QuizshowRandom,
  type QuizshowSnapshotQuestion,
  type QuizshowSnapshotRound,
} from './quizshow-snapshot';

export interface QuizshowNewTeamInput {
  name: string;
  colorKey: QuizshowTeamColorKey;
}

export type QuizshowJoinTeamChoice =
  { teamId: string } | { newTeam: QuizshowNewTeamInput } | null;

export interface QuizshowJoinLobbyInput {
  userId: string;
  isCohostPlayer: boolean;
  avatarUrl: string | null;
  screenName: string;
  isAvatarShown: boolean;
  hasExtraTime: boolean;
  team: QuizshowJoinTeamChoice;
}

export interface QuizshowSubmitAnswerInput {
  phaseId: string;
  questionId: string;
  payload: QuizshowAnswerPayload;
}

export interface QuizshowSubmitVoteInput {
  phaseId: string;
  questionId: string;
  optionId: string;
}

type MeOutcome = QuizshowCommandOutcome<{ me: QuizshowMe }>;

type PlayerUpdateFields = Extract<
  QuizshowPersistOperation,
  { type: 'update_player' }
>['fields'];

type PlayerLookup =
  | { player: QuizshowLivePlayer; refusal: null }
  | { player: null; refusal: QuizshowErrorCode };

/** The player behind a player frame: unknown ids have not joined, removed players stay out. */
function lookUpPlayer(
  state: QuizshowLiveState,
  playerId: string,
): PlayerLookup {
  const player = state.players.get(playerId);
  if (player === undefined) {
    return { player: null, refusal: 'quizshow_not_joined' };
  }
  if (player.removedAt !== null) {
    return { player: null, refusal: 'quizshow_player_removed' };
  }
  return { player, refusal: null };
}

/** A screen name, team name or written answer, already trimmed: blank or blocked texts are refused. */
function textRefusal(trimmedText: string): QuizshowErrorCode | null {
  if (trimmedText === '') return 'quizshow_text_blank';
  if (textHasBlockedTerm(trimmedText)) return 'quizshow_text_blocked';
  return null;
}

function teamNameKey(name: string): string {
  return name.trim().toLowerCase();
}

function activeMemberCount(state: QuizshowLiveState, teamId: string): number {
  return activePlayers(state).filter((player) => player.teamId === teamId)
    .length;
}

function isTeamFull(state: QuizshowLiveState, teamId: string): boolean {
  return (
    state.maxTeamSize !== null &&
    activeMemberCount(state, teamId) >= state.maxTeamSize
  );
}

/** Checks a team a player wants to found: name, the session's team limit, a free name and a free colour. */
function newTeamRefusal(
  state: QuizshowLiveState,
  trimmedName: string,
  colorKey: QuizshowTeamColorKey,
): QuizshowErrorCode | null {
  const nameRefusal = textRefusal(trimmedName);
  if (nameRefusal !== null) return nameRefusal;
  const teams = [...state.teams.values()];
  if (teams.length >= QUIZSHOW_LIMITS.teamsPerSessionMax) {
    return 'quizshow_team_limit';
  }
  const nameKey = teamNameKey(trimmedName);
  if (teams.some((team) => teamNameKey(team.name) === nameKey)) {
    return 'quizshow_team_name_taken';
  }
  if (teams.some((team) => team.colorKey === colorKey)) {
    return 'quizshow_team_color_taken';
  }
  return null;
}

function buildTeam(
  trimmedName: string,
  colorKey: QuizshowTeamColorKey,
  now: number,
  random: QuizshowRandom,
): QuizshowLiveTeam {
  return {
    teamId: random.uuid(),
    name: trimmedName,
    colorKey,
    score: 0,
    hasUsedJoker: false,
    jokerRoundIndex: null,
    createdAt: now,
  };
}

function findPlayerOfUser(
  state: QuizshowLiveState,
  userId: string,
): QuizshowLivePlayer | null {
  for (const player of state.players.values()) {
    if (player.userId === userId) return player;
  }
  return null;
}

/**
 * `lobby:join`. A user who already has a row gets its `me` back unchanged; a
 * late joiner enters with `joinedAt = now` and plays from the next question.
 */
export function joinLobby(
  state: QuizshowLiveState,
  input: QuizshowJoinLobbyInput,
  now: number,
  random: QuizshowRandom,
): MeOutcome {
  const existingPlayer = findPlayerOfUser(state, input.userId);
  if (existingPlayer !== null) {
    if (existingPlayer.removedAt !== null) {
      return refuse('quizshow_player_removed', state, false);
    }
    return succeed({ me: toMe(state, existingPlayer.playerId) }, []);
  }
  if (state.status === 'finished' || state.status === 'abandoned') {
    return refuse('quizshow_session_finished', state, false);
  }
  if (activePlayers(state).length >= QUIZSHOW_LIMITS.playersPerSessionMax) {
    return refuse('quizshow_session_full', state, false);
  }
  const screenName = input.screenName.trim();
  const nameRefusal = textRefusal(screenName);
  if (nameRefusal !== null) return refuse(nameRefusal, state, false);

  const effects: QuizshowEngineEffect[] = [];
  let teamId: string | null = null;
  if (state.playMode === 'solo') {
    if (input.team !== null) {
      return refuse('quizshow_command_not_allowed', state, true);
    }
  } else if (input.team === null) {
    return refuse('quizshow_team_required', state, false);
  } else if ('teamId' in input.team) {
    const team = state.teams.get(input.team.teamId);
    if (team === undefined) {
      return refuse('quizshow_team_not_found', state, false);
    }
    if (isTeamFull(state, team.teamId)) {
      return refuse('quizshow_team_full', state, false);
    }
    teamId = team.teamId;
  } else {
    if (state.status !== 'lobby') {
      return refuse('quizshow_team_change_closed', state, false);
    }
    const teamName = input.team.newTeam.name.trim();
    const colorKey = input.team.newTeam.colorKey;
    const teamRefusal = newTeamRefusal(state, teamName, colorKey);
    if (teamRefusal !== null) return refuse(teamRefusal, state, false);
    const team = buildTeam(teamName, colorKey, now, random);
    state.teams.set(team.teamId, team);
    effects.push(persist({ type: 'insert_team', team: { ...team } }));
    teamId = team.teamId;
  }

  const player: QuizshowLivePlayer = {
    playerId: random.uuid(),
    userId: input.userId,
    screenName,
    teamId,
    isCohostPlayer: input.isCohostPlayer,
    isAvatarShown: input.isAvatarShown,
    avatarUrl: input.avatarUrl,
    hasExtraTime: input.hasExtraTime,
    score: 0,
    streak: 0,
    hasUsedJoker: false,
    jokerRoundIndex: null,
    joinedAt: now,
    removedAt: null,
    connectedSocketCount: 0,
  };
  state.players.set(player.playerId, player);
  effects.push(persist({ type: 'insert_player', player: { ...player } }));
  effects.push({ kind: 'lobby_changed' });
  return succeed({ me: toMe(state, player.playerId) }, effects);
}

/** The effects of a change to one player's own row. */
function playerChangedEffects(
  playerId: string,
  fields: PlayerUpdateFields,
): QuizshowEngineEffect[] {
  return [
    persist({ type: 'update_player', playerId, fields }),
    { kind: 'lobby_changed' },
    { kind: 'me_changed', playerIds: [playerId] },
  ];
}

/** `lobby:setName`, lobby only. */
export function setScreenName(
  state: QuizshowLiveState,
  playerId: string,
  screenName: string,
  _now: number,
): MeOutcome {
  const lookup = lookUpPlayer(state, playerId);
  if (lookup.player === null) return refuse(lookup.refusal, state, false);
  const player = lookup.player;
  if (state.status !== 'lobby') {
    return refuse('quizshow_team_change_closed', state, false);
  }
  const trimmedName = screenName.trim();
  const nameRefusal = textRefusal(trimmedName);
  if (nameRefusal !== null) return refuse(nameRefusal, state, false);
  if (trimmedName === player.screenName) {
    return succeed({ me: toMe(state, playerId) }, []);
  }
  player.screenName = trimmedName;
  return succeed(
    { me: toMe(state, playerId) },
    playerChangedEffects(playerId, { screenName: trimmedName }),
  );
}

/** `lobby:pickTeam`, teams play in the lobby only. */
export function pickTeam(
  state: QuizshowLiveState,
  playerId: string,
  teamId: string,
  _now: number,
): MeOutcome {
  const lookup = lookUpPlayer(state, playerId);
  if (lookup.player === null) return refuse(lookup.refusal, state, false);
  const player = lookup.player;
  if (state.playMode === 'solo') {
    return refuse('quizshow_command_not_allowed', state, true);
  }
  if (state.status !== 'lobby') {
    return refuse('quizshow_team_change_closed', state, false);
  }
  const team = state.teams.get(teamId);
  if (team === undefined) {
    return refuse('quizshow_team_not_found', state, false);
  }
  if (player.teamId === team.teamId) {
    return succeed({ me: toMe(state, playerId) }, []);
  }
  if (isTeamFull(state, team.teamId)) {
    return refuse('quizshow_team_full', state, false);
  }
  player.teamId = team.teamId;
  return succeed(
    { me: toMe(state, playerId) },
    playerChangedEffects(playerId, { teamId: team.teamId }),
  );
}

/** `lobby:createTeam`, teams play in the lobby only; the creator moves into the new team. */
export function createTeam(
  state: QuizshowLiveState,
  playerId: string,
  input: QuizshowNewTeamInput,
  now: number,
  random: QuizshowRandom,
): QuizshowCommandOutcome<{ me: QuizshowMe; teamId: string }> {
  const lookup = lookUpPlayer(state, playerId);
  if (lookup.player === null) return refuse(lookup.refusal, state, false);
  const player = lookup.player;
  if (state.playMode === 'solo') {
    return refuse('quizshow_command_not_allowed', state, true);
  }
  if (state.status !== 'lobby') {
    return refuse('quizshow_team_change_closed', state, false);
  }
  const teamName = input.name.trim();
  // A double tap finds the player already in the team they asked for: ack it with their current me.
  const heldTeam =
    player.teamId === null ? undefined : state.teams.get(player.teamId);
  if (
    heldTeam !== undefined &&
    heldTeam.colorKey === input.colorKey &&
    teamNameKey(heldTeam.name) === teamNameKey(teamName)
  ) {
    return succeed({ me: toMe(state, playerId), teamId: heldTeam.teamId }, []);
  }
  const teamRefusal = newTeamRefusal(state, teamName, input.colorKey);
  if (teamRefusal !== null) return refuse(teamRefusal, state, false);
  const team = buildTeam(teamName, input.colorKey, now, random);
  state.teams.set(team.teamId, team);
  player.teamId = team.teamId;
  return succeed({ me: toMe(state, playerId), teamId: team.teamId }, [
    persist({ type: 'insert_team', team: { ...team } }),
    ...playerChangedEffects(playerId, { teamId: team.teamId }),
  ]);
}

/** `settings:extraTime`, any time; it applies from the next question that opens. */
export function setExtraTime(
  state: QuizshowLiveState,
  playerId: string,
  hasExtraTime: boolean,
  _now: number,
): MeOutcome {
  const lookup = lookUpPlayer(state, playerId);
  if (lookup.player === null) return refuse(lookup.refusal, state, false);
  const player = lookup.player;
  if (player.hasExtraTime === hasExtraTime) {
    return succeed({ me: toMe(state, playerId) }, []);
  }
  player.hasExtraTime = hasExtraTime;
  return succeed(
    { me: toMe(state, playerId) },
    playerChangedEffects(playerId, { hasExtraTime }),
  );
}

/** `settings:avatar`, any time. */
export function setAvatarShown(
  state: QuizshowLiveState,
  playerId: string,
  isAvatarShown: boolean,
  _now: number,
): MeOutcome {
  const lookup = lookUpPlayer(state, playerId);
  if (lookup.player === null) return refuse(lookup.refusal, state, false);
  const player = lookup.player;
  if (player.isAvatarShown === isAvatarShown) {
    return succeed({ me: toMe(state, playerId) }, []);
  }
  player.isAvatarShown = isAvatarShown;
  return succeed(
    { me: toMe(state, playerId) },
    playerChangedEffects(playerId, { isAvatarShown }),
  );
}

/** The lobby for round 0, the intro of the round, or the leaderboard just before it. */
function isJokerMoment(state: QuizshowLiveState, roundIndex: number): boolean {
  const { phase, roundIndex: cursorRoundIndex } = state.cursor;
  if (phase === 'lobby') return roundIndex === 0;
  if (phase === 'round_intro') return cursorRoundIndex === roundIndex;
  if (phase === 'leaderboard') {
    return cursorRoundIndex !== null && roundIndex === cursorRoundIndex + 1;
  }
  return false;
}

/** A double tap: the joker of the player (solo) or their team (teams) is already on this round, even when the moment has passed since. */
function isJokerAlreadyOnRound(
  state: QuizshowLiveState,
  player: QuizshowLivePlayer,
  roundIndex: number,
): boolean {
  if (state.playMode === 'solo') {
    return player.hasUsedJoker && player.jokerRoundIndex === roundIndex;
  }
  const team =
    player.teamId === null ? undefined : state.teams.get(player.teamId);
  return (
    team !== undefined &&
    team.hasUsedJoker &&
    team.jokerRoundIndex === roundIndex
  );
}

/** `joker:play`: once per player in solo play, once per team in teams play. */
export function playJoker(
  state: QuizshowLiveState,
  playerId: string,
  roundIndex: number,
  _now: number,
): MeOutcome {
  const lookup = lookUpPlayer(state, playerId);
  if (lookup.player === null) return refuse(lookup.refusal, state, false);
  const player = lookup.player;
  if (isJokerAlreadyOnRound(state, player, roundIndex)) {
    return succeed({ me: toMe(state, playerId) }, []);
  }
  const round = state.snapshot.rounds[roundIndex];
  if (
    round === undefined ||
    !round.settings.isJokerAllowed ||
    !isJokerMoment(state, roundIndex)
  ) {
    return refuse('quizshow_joker_not_allowed', state, false);
  }
  if (state.playMode === 'solo') {
    if (player.hasUsedJoker) return refuse('quizshow_joker_used', state, false);
    player.hasUsedJoker = true;
    player.jokerRoundIndex = roundIndex;
    return succeed(
      { me: toMe(state, playerId) },
      playerChangedEffects(playerId, {
        hasUsedJoker: true,
        jokerRoundIndex: roundIndex,
      }),
    );
  }
  const team =
    player.teamId === null ? undefined : state.teams.get(player.teamId);
  if (team === undefined) {
    return refuse('quizshow_joker_not_allowed', state, false);
  }
  if (team.hasUsedJoker) return refuse('quizshow_joker_used', state, false);
  team.hasUsedJoker = true;
  team.jokerRoundIndex = roundIndex;
  const memberIds = activePlayers(state)
    .filter((member) => member.teamId === team.teamId)
    .map((member) => member.playerId);
  return succeed({ me: toMe(state, playerId) }, [
    persist({
      type: 'update_team',
      teamId: team.teamId,
      fields: { hasUsedJoker: true, jokerRoundIndex: roundIndex },
    }),
    { kind: 'lobby_changed' },
    { kind: 'me_changed', playerIds: memberIds },
  ]);
}

function toMyAnswer(answer: QuizshowLiveAnswer): QuizshowMyAnswer {
  return {
    questionId: answer.questionId,
    phaseId: answer.phaseId,
    payload: answer.payload,
    receivedAt: answer.receivedAt,
  };
}

function toMyVote(vote: QuizshowLiveVote): QuizshowMyVote {
  return { questionId: vote.questionId, optionId: vote.optionId };
}

/**
 * The checks answers and votes share once the duplicate check passed: the
 * phase id, a running session in the accepting phase, the question in play,
 * eligibility and the player's own deadline plus grace.
 */
function submissionRefusal(
  state: QuizshowLiveState,
  playerId: string,
  input: { phaseId: string; questionId: string },
  acceptingPhases: readonly QuizshowPhase[],
  now: number,
): QuizshowErrorCode | null {
  if (input.phaseId !== state.cursor.phaseId) return 'quizshow_stale_phase';
  if (
    state.status !== 'running' ||
    !acceptingPhases.includes(state.cursor.phase)
  ) {
    return 'quizshow_phase_closed';
  }
  if (state.current === null || state.current.questionId !== input.questionId) {
    return 'quizshow_wrong_question';
  }
  if (!isEligible(state, playerId)) return 'quizshow_not_eligible';
  const deadline = ownDeadline(state, playerId);
  if (deadline !== null && now > deadline + QUIZSHOW_LIMITS.answerGraceMs) {
    return 'quizshow_phase_closed';
  }
  return null;
}

function isPermutationOf(
  orderedIds: readonly string[],
  shownIds: readonly string[],
): boolean {
  if (orderedIds.length !== shownIds.length) return false;
  const remaining = new Set(shownIds);
  for (const optionId of orderedIds) {
    if (!remaining.delete(optionId)) return false;
  }
  return remaining.size === 0;
}

/** Too-close fakes a player may try per Lie Detector question; after these the question takes no more fakes from them. */
export const QUIZSHOW_TOO_CLOSE_FAKES_MAX = 3;

/**
 * Too-close refusals per player, keyed by the question play, so a new
 * question (or a restart replay) starts every count at 0. Lives here until
 * `QuizshowLiveQuestionPlay` gains a `tooCloseFakeCounts: Map<string, number>`
 * field. It caps the "too close" refusal as a truth oracle: probing guesses
 * stops after the third hit and the player can still vote.
 */
const TOO_CLOSE_FAKE_COUNTS = new WeakMap<
  QuizshowLiveQuestionPlay,
  Map<string, number>
>();

function tooCloseFakeCount(
  play: QuizshowLiveQuestionPlay,
  playerId: string,
): number {
  return TOO_CLOSE_FAKE_COUNTS.get(play)?.get(playerId) ?? 0;
}

function recordTooCloseFake(
  play: QuizshowLiveQuestionPlay,
  playerId: string,
): void {
  const counts = TOO_CLOSE_FAKE_COUNTS.get(play) ?? new Map<string, number>();
  counts.set(playerId, tooCloseFakeCount(play, playerId) + 1);
  TOO_CLOSE_FAKE_COUNTS.set(play, counts);
}

function isFakeLockedOut(
  play: QuizshowLiveQuestionPlay,
  playerId: string,
): boolean {
  return tooCloseFakeCount(play, playerId) >= QUIZSHOW_TOO_CLOSE_FAKES_MAX;
}

type PayloadCheck =
  | { payload: QuizshowAnswerPayload; refusal: null }
  | { payload: null; refusal: QuizshowErrorCode };

/** Checks a payload against the question in play and returns it as stored (texts trimmed). */
function checkAnswerPayload(
  round: QuizshowSnapshotRound,
  question: QuizshowSnapshotQuestion,
  payload: QuizshowAnswerPayload,
): PayloadCheck {
  const invalid: PayloadCheck = {
    payload: null,
    refusal: 'quizshow_invalid_answer',
  };
  if (payload.type !== question.type) return invalid;
  const shownOptions: readonly QuizshowOption[] =
    question.shownOptions ?? question.options;
  switch (payload.type) {
    case 'multiple_choice':
      return Number.isInteger(payload.optionIndex) &&
        payload.optionIndex >= 0 &&
        payload.optionIndex < shownOptions.length
        ? { payload: { ...payload }, refusal: null }
        : invalid;
    case 'true_false':
      return typeof payload.isTrue === 'boolean'
        ? { payload: { ...payload }, refusal: null }
        : invalid;
    case 'order':
      return Array.isArray(payload.orderedIds) &&
        isPermutationOf(
          payload.orderedIds,
          shownOptions.map((option) => option.id),
        )
        ? {
            payload: { type: 'order', orderedIds: [...payload.orderedIds] },
            refusal: null,
          }
        : invalid;
    case 'closest_number':
      return Number.isFinite(payload.value) &&
        Math.abs(payload.value) <= QUIZSHOW_LIMITS.numberAbsMax
        ? { payload: { ...payload }, refusal: null }
        : invalid;
    case 'type_answer': {
      const text = payload.text.trim();
      const refusal = textRefusal(text);
      if (refusal !== null) return { payload: null, refusal };
      return { payload: { type: 'type_answer', text }, refusal: null };
    }
    case 'prompt': {
      const text = payload.text.trim();
      const refusal = textRefusal(text);
      if (refusal !== null) return { payload: null, refusal };
      if (
        round.kind === 'lie_detector' &&
        question.type === 'prompt' &&
        question.answer !== null &&
        isTypedAnswerMatch(text, [
          question.answer.truth.en,
          question.answer.truth.pt,
        ])
      ) {
        return { payload: null, refusal: 'quizshow_fake_too_close' };
      }
      return { payload: { type: 'prompt', text }, refusal: null };
    }
  }
}

function storedAnswerOf(
  current: QuizshowLiveQuestionPlay | null,
  playerId: string,
  questionId: string,
): QuizshowLiveAnswer | null {
  if (current === null || current.questionId !== questionId) return null;
  return current.answers.get(playerId) ?? null;
}

/** `answer:submit`: the first answer per player per question wins; only an accepted answer is stored. */
export function submitAnswer(
  state: QuizshowLiveState,
  playerId: string,
  input: QuizshowSubmitAnswerInput,
  now: number,
  random: QuizshowRandom,
): QuizshowCommandOutcome<{
  answer: QuizshowMyAnswer;
  isDuplicate: boolean;
}> {
  const lookup = lookUpPlayer(state, playerId);
  if (lookup.player === null) return refuse(lookup.refusal, state, false);
  const storedAnswer = storedAnswerOf(
    state.current,
    playerId,
    input.questionId,
  );
  if (storedAnswer !== null) {
    return succeed({ answer: toMyAnswer(storedAnswer), isDuplicate: true }, []);
  }
  const refusal = submissionRefusal(
    state,
    playerId,
    input,
    ['open', 'write'],
    now,
  );
  if (refusal !== null) {
    return refuse(refusal, state, refusal === 'quizshow_stale_phase');
  }
  const current = state.current;
  if (current === null) return refuse('quizshow_wrong_question', state, false);
  const round = state.snapshot.rounds[current.roundIndex];
  const question = snapshotQuestionAt(
    state.snapshot,
    current.roundIndex,
    current.questionIndex,
  );
  if (round === undefined || question === null) {
    return refuse('quizshow_wrong_question', state, false);
  }
  const payloadCheck = checkAnswerPayload(round, question, input.payload);
  if (payloadCheck.refusal === 'quizshow_fake_too_close') {
    recordTooCloseFake(current, playerId);
    return refuse('quizshow_fake_too_close', state, false);
  }
  if (payloadCheck.payload === null) {
    return refuse(payloadCheck.refusal, state, false);
  }
  if (round.kind === 'lie_detector' && isFakeLockedOut(current, playerId)) {
    return refuse('quizshow_fake_too_close', state, false);
  }
  const phaseStartedAt = state.cursor.phaseStartedAt ?? now;
  const answer: QuizshowLiveAnswer = {
    answerId: random.uuid(),
    playerId,
    questionId: current.questionId,
    phaseId: state.cursor.phaseId,
    payload: payloadCheck.payload,
    receivedAt: now,
    elapsedMs: question.type === 'prompt' ? null : now - phaseStartedAt,
    isCorrect: null,
    correctPositions: null,
    pointsAwarded: 0,
    streakBonus: 0,
    voteOptionId: null,
    hiddenAt: null,
  };
  current.answers.set(playerId, answer);
  return succeed({ answer: toMyAnswer(answer), isDuplicate: false }, [
    persist({ type: 'insert_answer', answer: { ...answer } }),
    { kind: 'answer_accepted', playerId, questionId: current.questionId },
    { kind: 'answer_count_changed' },
  ]);
}

/** `vote:submit`: one vote per player per question, for a visible option another player wrote (or the truth). */
export function submitVote(
  state: QuizshowLiveState,
  playerId: string,
  input: QuizshowSubmitVoteInput,
  now: number,
): QuizshowCommandOutcome<{ vote: QuizshowMyVote; isDuplicate: boolean }> {
  const lookup = lookUpPlayer(state, playerId);
  if (lookup.player === null) return refuse(lookup.refusal, state, false);
  const current = state.current;
  if (current !== null && current.questionId === input.questionId) {
    const storedVote = current.votes.get(playerId);
    if (storedVote !== undefined) {
      return succeed({ vote: toMyVote(storedVote), isDuplicate: true }, []);
    }
  }
  const refusal = submissionRefusal(state, playerId, input, ['vote'], now);
  if (refusal !== null) {
    return refuse(refusal, state, refusal === 'quizshow_stale_phase');
  }
  if (current === null) return refuse('quizshow_wrong_question', state, false);
  const option = (current.voteOptions ?? []).find(
    (voteOption) => voteOption.optionId === input.optionId,
  );
  if (option === undefined) {
    return refuse('quizshow_vote_option_not_found', state, false);
  }
  const isHiddenOption =
    option.answerId !== null &&
    [...current.answers.values()].some(
      (answer) =>
        answer.answerId === option.answerId && answer.hiddenAt !== null,
    );
  if (isHiddenOption) {
    return refuse('quizshow_vote_option_not_found', state, false);
  }
  if (option.authorPlayerId === playerId) {
    return refuse('quizshow_own_answer_vote', state, false);
  }
  const vote: QuizshowLiveVote = {
    voterPlayerId: playerId,
    questionId: current.questionId,
    optionId: option.optionId,
    answerId: option.answerId,
    createdAt: now,
  };
  current.votes.set(playerId, vote);
  return succeed({ vote: toMyVote(vote), isDuplicate: false }, [
    persist({ type: 'insert_vote', vote: { ...vote } }),
    { kind: 'answer_count_changed' },
  ]);
}
