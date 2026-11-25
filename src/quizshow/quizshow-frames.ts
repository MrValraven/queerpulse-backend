/**
 * Pulse Live (`quizshow`) server to client frames and `session:state`, one
 * builder per frame and role. Pure: every builder only reads the live state.
 *
 * Privacy boundary: the screen and players see no answer key, truth, reveal
 * note or vote count before `reveal`; no frame carries a user id, member slug
 * or profile name; `avatarUrl` reaches the screen and hosts only, while
 * `isAvatarShown`. During a host-paced podium the screen and players see only
 * the places revealed so far (contract 6.7).
 */
import {
  QUIZSHOW_LIMITS,
  type QuizshowAnswerCountFrame,
  type QuizshowAnswerKeyView,
  type QuizshowDistribution,
  type QuizshowGivingLink,
  type QuizshowHostLobby,
  type QuizshowHostPlayer,
  type QuizshowHostQuestionView,
  type QuizshowHostState,
  type QuizshowHostTeam,
  type QuizshowHostTypedAnswers,
  type QuizshowHostVoteOptions,
  type QuizshowLeaderboardEntry,
  type QuizshowLobby,
  type QuizshowLobbyPlayer,
  type QuizshowLobbyTeam,
  type QuizshowMyAnswer,
  type QuizshowMyReveal,
  type QuizshowMyScores,
  type QuizshowMyVote,
  type QuizshowOption,
  type QuizshowPairedDevice,
  type QuizshowPartyRevealEntry,
  type QuizshowPhase,
  type QuizshowPhaseChangeFrame,
  type QuizshowPlayerLobby,
  type QuizshowPlayerState,
  type QuizshowPodiumEntry,
  type QuizshowPodiumFrame,
  type QuizshowQuestionView,
  type QuizshowReveal,
  type QuizshowReviewList,
  type QuizshowRoundCard,
  type QuizshowScores,
  type QuizshowScoresScope,
  type QuizshowScreenState,
  type QuizshowSessionEnd,
  type QuizshowSessionState,
  type QuizshowStateBase,
  type QuizshowText,
  type QuizshowTypedAnswerGroup,
  type QuizshowVoteOptions,
  type QuizshowWheelBonusView,
  type QuizshowWheelView,
} from './quizshow.contract';
import { normaliseAnswerText } from './quizshow-answer-normaliser';
import {
  activePlayers,
  buildRankIndex,
  eligiblePlayersNow,
  isActivePlayer,
  isEligible,
  isJokerActiveFor,
  podiumSteps,
  rankOf,
  revealedPodiumPlaces,
  toMe,
  type QuizshowRankIndex,
} from './quizshow-engine-state';
import type {
  QuizshowLiveAnswer,
  QuizshowLivePlayer,
  QuizshowLiveQuestionPlay,
  QuizshowLiveState,
  QuizshowLiveTeam,
  QuizshowLiveVoteOption,
} from './quizshow-engine-types';
import { closestNumberOutcomes, type ClosestOutcome } from './quizshow-scoring';
import {
  effectiveAnswerKey,
  toHostQuestionView,
  toQuestionView,
  toRoundCard,
  type QuizshowSnapshotQuestion,
  type QuizshowSnapshotRound,
} from './quizshow-snapshot';
import { wheelBonusViewForCursor, wheelViewForCursor } from './quizshow-wheel';

/** Contract 7.1 names frames as the home of the rank index; it lives in engine state so phases can share it. */
export { buildRankIndex } from './quizshow-engine-state';

export type QuizshowRoleRoom = 'screen' | 'players' | 'hosts';

/** Who a withholding frame is for: the screen and players see revealed podium places only, hosts see every place. */
export type QuizshowFrameAudience = 'public' | 'hosts';

export type QuizshowSessionStateViewer =
  | { role: 'screen' }
  | { role: 'host' }
  | { role: 'player'; playerId: string | null; suggestedScreenName: string };

/** The most distinct wrong spellings `typed:answers` lists (contract 2.6). */
const TYPED_ANSWER_GROUPS_MAX = 30;

/** Phases that show the current question: `read` to `scores` in a quiz round, `write` to `reveal` in a party round. */
const QUESTION_PHASES: ReadonlySet<QuizshowPhase> = new Set<QuizshowPhase>([
  'read',
  'open',
  'write',
  'review',
  'vote',
  'reveal',
  'scores',
]);

/** Phases whose `answer:count` is live; `read` carries the zero count the question opens with. */
const COUNTED_PHASES: ReadonlySet<QuizshowPhase> = new Set<QuizshowPhase>([
  'read',
  'open',
  'write',
  'review',
  'vote',
]);

/** Phases that hold the question's `reveal`. */
const REVEAL_PHASES: ReadonlySet<QuizshowPhase> = new Set<QuizshowPhase>([
  'reveal',
  'scores',
]);

/** Phases with no round card. */
const ROUNDLESS_PHASES: ReadonlySet<QuizshowPhase> = new Set<QuizshowPhase>([
  'lobby',
  'wheel',
  'podium',
  'ended',
]);

export function quizshowRoomName(
  sessionId: string,
  room: QuizshowRoleRoom,
): string {
  return `qs:${sessionId}:${room}`;
}

export function quizshowPlayerRoomName(
  sessionId: string,
  playerId: string,
): string {
  return `qs:${sessionId}:player:${playerId}`;
}

interface QuizshowShownQuestion {
  round: QuizshowSnapshotRound;
  question: QuizshowSnapshotQuestion;
  roundIndex: number;
  questionIndex: number;
  /** The live play of that question, or null when the state holds another one. */
  play: QuizshowLiveQuestionPlay | null;
}

/** The question on show in this phase, from the live play first and the cursor second; null outside question phases. */
function shownQuestion(state: QuizshowLiveState): QuizshowShownQuestion | null {
  if (!QUESTION_PHASES.has(state.cursor.phase)) return null;
  const roundIndex = state.current?.roundIndex ?? state.cursor.roundIndex;
  const questionIndex =
    state.current?.questionIndex ?? state.cursor.questionIndex;
  if (roundIndex === null || questionIndex === null) return null;
  const round = state.snapshot.rounds[roundIndex];
  const question = round?.questions[questionIndex];
  if (round === undefined || question === undefined) return null;
  const play =
    state.current !== null && state.current.questionId === question.id
      ? state.current
      : null;
  return { round, question, roundIndex, questionIndex, play };
}

function publicQuestionView(
  state: QuizshowLiveState,
): QuizshowQuestionView | null {
  const shown = shownQuestion(state);
  if (shown === null) return null;
  return toQuestionView(
    shown.round,
    shown.question,
    shown.roundIndex,
    shown.questionIndex,
    state.snapshot.languages,
  );
}

/** The host view shows a host correction in `answerKey` once one was made (contract 6.4 rule 8). */
function hostQuestionView(
  state: QuizshowLiveState,
): QuizshowHostQuestionView | null {
  const shown = shownQuestion(state);
  if (shown === null) return null;
  return toHostQuestionView(
    shown.round,
    shown.question,
    shown.roundIndex,
    shown.questionIndex,
    state.snapshot.languages,
    shown.play?.keyOverride ?? null,
  );
}

function currentRoundCard(state: QuizshowLiveState): QuizshowRoundCard | null {
  const { phase, roundIndex } = state.cursor;
  if (ROUNDLESS_PHASES.has(phase) || roundIndex === null) return null;
  const round = state.snapshot.rounds[roundIndex];
  return round === undefined
    ? null
    : toRoundCard(round, roundIndex, state.playMode);
}

/** The wheel view is the same for every role: it holds no answer and no secret. */
function wheelOf(state: QuizshowLiveState): QuizshowWheelView | null {
  return wheelViewForCursor(
    state.snapshot.rounds,
    state.wheelProgress,
    state.cursor,
  );
}

function wheelBonusOf(state: QuizshowLiveState): QuizshowWheelBonusView | null {
  return wheelBonusViewForCursor(state.wheelProgress, state.cursor);
}

function isPlayerActive(
  state: QuizshowLiveState,
  playerId: string | null,
): boolean {
  if (playerId === null) return false;
  const player = state.players.get(playerId);
  return player !== undefined && isActivePlayer(player);
}

function activePlayerOf(
  state: QuizshowLiveState,
  playerId: string | null,
): QuizshowLivePlayer | null {
  if (playerId === null) return null;
  const player = state.players.get(playerId);
  return player !== undefined && isActivePlayer(player) ? player : null;
}

function teamsInCreatedOrder(state: QuizshowLiveState): QuizshowLiveTeam[] {
  if (state.playMode === 'solo') return [];
  return [...state.teams.values()].sort(
    (firstTeam, secondTeam) => firstTeam.createdAt - secondTeam.createdAt,
  );
}

/** The stored avatar while the player shows it and the audience may see avatars. */
function visibleAvatarUrl(
  player: QuizshowLivePlayer,
  isAvatarAudience: boolean,
): string | null {
  return isAvatarAudience && player.isAvatarShown ? player.avatarUrl : null;
}

function toLobbyPlayer(
  player: QuizshowLivePlayer,
  isAvatarAudience: boolean,
): QuizshowLobbyPlayer {
  return {
    playerId: player.playerId,
    screenName: player.screenName,
    teamId: player.teamId,
    avatarUrl: visibleAvatarUrl(player, isAvatarAudience),
  };
}

/** Members per team in one pass over the active players (contract 7.1), so a 24 team lobby costs one walk. */
function memberCountsByTeam(
  players: readonly QuizshowLivePlayer[],
): Map<string, number> {
  const memberCounts = new Map<string, number>();
  for (const player of players) {
    if (player.teamId === null) continue;
    memberCounts.set(player.teamId, (memberCounts.get(player.teamId) ?? 0) + 1);
  }
  return memberCounts;
}

function toLobbyTeam(
  team: QuizshowLiveTeam,
  memberCounts: ReadonlyMap<string, number>,
): QuizshowLobbyTeam {
  return {
    teamId: team.teamId,
    name: team.name,
    colorKey: team.colorKey,
    memberCount: memberCounts.get(team.teamId) ?? 0,
    isHostMade: team.isHostMade,
  };
}

function lobbyTeams(
  state: QuizshowLiveState,
  players: readonly QuizshowLivePlayer[],
): QuizshowLobbyTeam[] {
  const memberCounts = memberCountsByTeam(players);
  return teamsInCreatedOrder(state).map((team) =>
    toLobbyTeam(team, memberCounts),
  );
}

/**
 * `lobby:update` for the screen: the roster with avatars. The players room
 * gets `buildPlayerLobby`. The audience argument stays so every call site
 * names the screen.
 */
export function buildLobby(
  state: QuizshowLiveState,
  _audience: 'screen',
): QuizshowLobby {
  const players = activePlayers(state);
  return {
    players: players.map((player) => toLobbyPlayer(player, true)),
    teams: lobbyTeams(state, players),
    playerCount: players.length,
  };
}

/**
 * `lobby:update` and the lobby of `session:state` for the players room (W2):
 * team cards and the head count only, so a lobby tick stays small for every
 * phone.
 */
export function buildPlayerLobby(
  state: QuizshowLiveState,
): QuizshowPlayerLobby {
  const players = activePlayers(state);
  return { teams: lobbyTeams(state, players), playerCount: players.length };
}

/** `lobby:update` for the hosts room: avatars, scores, streaks, jokers and connection state. */
export function buildHostLobby(state: QuizshowLiveState): QuizshowHostLobby {
  const players = activePlayers(state);
  const memberCounts = memberCountsByTeam(players);
  return {
    players: players.map((player): QuizshowHostPlayer => ({
      ...toLobbyPlayer(player, true),
      isCohostPlayer: player.isCohostPlayer,
      hasExtraTime: player.hasExtraTime,
      hasUsedJoker: toMe(state, player.playerId).hasUsedJoker,
      score: player.score,
      streak: player.streak,
      isConnected: player.connectedSocketCount > 0,
      disconnectedAt: player.disconnectedAt,
      joinedAt: player.joinedAt,
    })),
    teams: teamsInCreatedOrder(state).map((team): QuizshowHostTeam => ({
      ...toLobbyTeam(team, memberCounts),
      score: team.score,
      hasUsedJoker: team.hasUsedJoker,
    })),
    playerCount: players.length,
  };
}

/** `devices:update` and the host state: unrevoked pairings in paired order; a helper's name only on a helper (contract 6.5). */
export function buildPairedDevices(
  state: QuizshowLiveState,
): QuizshowPairedDevice[] {
  return state.pairedDevices
    .filter((device) => device.revokedAt === null)
    .map((device): QuizshowPairedDevice => ({
      pairingId: device.pairingId,
      kind: device.kind,
      helperName: device.kind === 'helper' ? device.helperName : null,
      pairedAt: device.pairedAt,
      isConnected: device.connectedSocketCount > 0,
    }));
}

/** `session:flags` to every role room (contract 6.15, 6.16). */
export function buildSessionFlags(state: QuizshowLiveState): {
  isJoinLocked: boolean;
  isAutoAdvanceOn: boolean;
} {
  return {
    isJoinLocked: state.isJoinLocked,
    isAutoAdvanceOn: state.isAutoAdvanceOn,
  };
}

/** `phase:change`: the public question view for the screen and players, the host view (with the answer key) for hosts. */
export function buildPhaseChange(
  state: QuizshowLiveState,
  audience: 'public' | 'host',
): QuizshowPhaseChangeFrame {
  return {
    cursor: { ...state.cursor },
    round: currentRoundCard(state),
    question:
      audience === 'host' ? hostQuestionView(state) : publicQuestionView(state),
    wheel: wheelOf(state),
    wheelBonus: wheelBonusOf(state),
  };
}

/** `answer:count`: answers in `read`, `open` and `write`, submissions in `review`, votes in `vote`, out of the eligible players still in the session. */
export function buildAnswerCount(
  state: QuizshowLiveState,
): QuizshowAnswerCountFrame | null {
  if (!COUNTED_PHASES.has(state.cursor.phase)) return null;
  const play = shownQuestion(state)?.play ?? null;
  if (play === null) return null;
  const eligiblePlayers = eligiblePlayersNow(state);
  const isCountingVotes = state.cursor.phase === 'vote';
  const count = eligiblePlayers.filter((player) =>
    isCountingVotes
      ? play.votes.has(player.playerId)
      : play.answers.has(player.playerId),
  ).length;
  return {
    phaseId: state.cursor.phaseId,
    count,
    total: eligiblePlayers.length,
  };
}

function partyTextOf(answer: QuizshowLiveAnswer): string | null {
  return answer.payload.type === 'prompt' ? answer.payload.text : null;
}

/** `review:list` for hosts during `review`: every submission with its author, hidden ones flagged. */
export function buildReviewList(
  state: QuizshowLiveState,
): QuizshowReviewList | null {
  if (state.cursor.phase !== 'review') return null;
  const play = shownQuestion(state)?.play ?? null;
  if (play === null) return null;
  const submissions = [...play.answers.values()]
    .sort(
      (firstAnswer, secondAnswer) =>
        firstAnswer.receivedAt - secondAnswer.receivedAt,
    )
    .flatMap((answer) => {
      const author = state.players.get(answer.playerId);
      const text = partyTextOf(answer);
      if (author === undefined || text === null) return [];
      return [
        {
          answerId: answer.answerId,
          playerId: answer.playerId,
          screenName: author.screenName,
          text,
          isHidden: answer.hiddenAt !== null,
          receivedAt: answer.receivedAt,
        },
      ];
    });
  return {
    phaseId: state.cursor.phaseId,
    questionId: play.questionId,
    submissions,
  };
}

/** One map read (W1): a vote round reads it once per option. */
function answerById(
  play: QuizshowLiveQuestionPlay,
  answerId: string,
): QuizshowLiveAnswer | undefined {
  return play.answersById.get(answerId);
}

/** The truth always shows; a submission shows while it is not hidden and its author is still in the session. */
function isVoteOptionVisible(
  state: QuizshowLiveState,
  play: QuizshowLiveQuestionPlay,
  option: QuizshowLiveVoteOption,
): boolean {
  if (option.answerId === null) return true;
  const answer = answerById(play, option.answerId);
  return (
    answer !== undefined &&
    answer.hiddenAt === null &&
    isPlayerActive(state, option.authorPlayerId)
  );
}

/**
 * The vote options a voter may see. The runtime computes them once per
 * `vote:options` fan-out and passes them to every `buildVoteOptions` call
 * (W1). It needs the state beside the play: an option hides once its author
 * leaves the session.
 */
export function visibleVoteOptions(
  state: QuizshowLiveState,
  play: QuizshowLiveQuestionPlay,
): QuizshowLiveVoteOption[] {
  return (play.voteOptions ?? []).filter((option) =>
    isVoteOptionVisible(state, play, option),
  );
}

function votingPlay(state: QuizshowLiveState): QuizshowLiveQuestionPlay | null {
  if (state.cursor.phase !== 'vote') return null;
  const play = shownQuestion(state)?.play ?? null;
  return play !== null && play.voteOptions !== null ? play : null;
}

/**
 * `vote:options` during `vote`: visible options with no author and no truth
 * flag; `ownOptionId` is the receiving player's own answer. `visibleOptions`
 * is the list `visibleVoteOptions` built for the whole fan-out; without it
 * this call builds its own.
 */
export function buildVoteOptions(
  state: QuizshowLiveState,
  forPlayerId: string | null,
  visibleOptions?: readonly QuizshowLiveVoteOption[],
): QuizshowVoteOptions | null {
  const play = votingPlay(state);
  if (play === null) return null;
  const options = visibleOptions ?? visibleVoteOptions(state, play);
  const ownOption =
    forPlayerId === null
      ? undefined
      : options.find((option) => option.authorPlayerId === forPlayerId);
  return {
    phaseId: state.cursor.phaseId,
    questionId: play.questionId,
    options: options.map((option) => ({
      optionId: option.optionId,
      text: option.text,
    })),
    ownOptionId: ownOption?.optionId ?? null,
  };
}

/** `vote:options` for hosts: each option with its answer id, author screen name and truth flag. */
export function buildHostVoteOptions(
  state: QuizshowLiveState,
): QuizshowHostVoteOptions | null {
  const play = votingPlay(state);
  if (play === null) return null;
  return {
    phaseId: state.cursor.phaseId,
    questionId: play.questionId,
    options: visibleVoteOptions(state, play).map((option) => ({
      optionId: option.optionId,
      text: option.text,
      answerId: option.answerId,
      authorName: authorNameOf(state, option),
      isTruth: option.isTruth,
    })),
    ownOptionId: null,
  };
}

function authorNameOf(
  state: QuizshowLiveState,
  option: QuizshowLiveVoteOption,
): string | null {
  if (option.isTruth || option.authorPlayerId === null) return null;
  return state.players.get(option.authorPlayerId)?.screenName ?? null;
}

/** The phase id the question was revealed in: the current one in `reveal`, the one before in `scores`. */
function revealPhaseId(state: QuizshowLiveState): string {
  const lastTransition = state.lastTransition;
  if (
    state.cursor.phase === 'scores' &&
    lastTransition !== null &&
    lastTransition.toPhaseId === state.cursor.phaseId
  ) {
    return lastTransition.fromPhaseId;
  }
  return state.cursor.phaseId;
}

/** The key the question is judged by tonight: a host correction when one was made (contract 6.4 rule 8). */
function shownAnswerKey(
  shown: QuizshowShownQuestion,
): QuizshowAnswerKeyView | null {
  return effectiveAnswerKey(
    shown.round,
    shown.question,
    shown.play?.keyOverride ?? null,
  );
}

function correctPositionsOf(
  answerKey: QuizshowAnswerKeyView | null,
  answer: QuizshowLiveAnswer,
): number {
  if (answerKey?.type !== 'order' || answer.payload.type !== 'order') return 0;
  const orderedIds = answerKey.orderedIds;
  const submittedIds = answer.payload.orderedIds;
  return orderedIds.filter(
    (optionId, position) => submittedIds[position] === optionId,
  ).length;
}

function eligibleAnswersOf(
  play: QuizshowLiveQuestionPlay,
  eligiblePlayers: readonly QuizshowLivePlayer[],
): QuizshowLiveAnswer[] {
  return eligiblePlayers.flatMap((player) => {
    const answer = play.answers.get(player.playerId);
    return answer === undefined ? [] : [answer];
  });
}

/** Multiple choice and poll: picks per shown option. Which options are right rides in `correct`, null on a poll. */
function optionsDistribution(
  question: QuizshowSnapshotQuestion,
  answers: readonly QuizshowLiveAnswer[],
): QuizshowDistribution {
  const shownOptions: readonly QuizshowOption[] =
    question.shownOptions ?? question.options;
  const counts = shownOptions.map(() => 0);
  for (const answer of answers) {
    if (
      answer.payload.type !== 'multiple_choice' &&
      answer.payload.type !== 'poll'
    ) {
      continue;
    }
    const optionIndex = answer.payload.optionIndex;
    const count = counts[optionIndex];
    if (count !== undefined) counts[optionIndex] = count + 1;
  }
  return { kind: 'options', counts };
}

function trueFalseDistribution(
  answers: readonly QuizshowLiveAnswer[],
): QuizshowDistribution {
  let trueCount = 0;
  let falseCount = 0;
  for (const answer of answers) {
    if (answer.payload.type !== 'true_false') continue;
    if (answer.payload.isTrue) trueCount += 1;
    else falseCount += 1;
  }
  return { kind: 'true_false', trueCount, falseCount };
}

function typedDistribution(
  answers: readonly QuizshowLiveAnswer[],
): QuizshowDistribution {
  const correctCount = answers.filter(
    (answer) => answer.isCorrect === true,
  ).length;
  return {
    kind: 'typed',
    correctCount,
    incorrectCount: answers.length - correctCount,
  };
}

function orderDistribution(
  answerKey: QuizshowAnswerKeyView | null,
  answers: readonly QuizshowLiveAnswer[],
): QuizshowDistribution {
  const itemCount =
    answerKey?.type === 'order' ? answerKey.orderedIds.length : 0;
  let exactCount = 0;
  let partialCount = 0;
  let noneCount = 0;
  for (const answer of answers) {
    const correctPositions = correctPositionsOf(answerKey, answer);
    if (itemCount > 0 && correctPositions === itemCount) exactCount += 1;
    else if (correctPositions > 0) partialCount += 1;
    else noneCount += 1;
  }
  return { kind: 'order', exactCount, partialCount, noneCount };
}

/** The closest players' names in joined order, the first one's value, and how many others landed inside the question's tolerance band (contract 6.1). */
function closestDistribution(
  answerKey: QuizshowAnswerKeyView | null,
  answers: readonly QuizshowLiveAnswer[],
  eligiblePlayers: readonly QuizshowLivePlayer[],
): QuizshowDistribution {
  const submittedValues = answers.flatMap((answer) =>
    answer.payload.type === 'closest_number'
      ? [{ playerId: answer.playerId, value: answer.payload.value }]
      : [],
  );
  const outcomes =
    answerKey?.type === 'closest_number'
      ? closestNumberOutcomes(
          answerKey.value,
          answerKey.tolerance,
          submittedValues,
        )
      : new Map<string, ClosestOutcome>();
  const closestPlayers = eligiblePlayers.filter(
    (player) => outcomes.get(player.playerId) === 'closest',
  );
  const firstClosestPlayer = closestPlayers[0];
  const closestValue =
    firstClosestPlayer === undefined
      ? null
      : (submittedValues.find(
          (submitted) => submitted.playerId === firstClosestPlayer.playerId,
        )?.value ?? null);
  return {
    kind: 'closest',
    closestValue,
    closestNames: closestPlayers.map((player) => player.screenName),
    withinBandCount: [...outcomes.values()].filter(
      (outcome) => outcome === 'band',
    ).length,
  };
}

/** Vote options as built at `vote`; a question that never reached `vote` falls back to its visible submissions. */
function revealOptions(
  state: QuizshowLiveState,
  play: QuizshowLiveQuestionPlay,
): QuizshowLiveVoteOption[] {
  if (play.voteOptions !== null) return visibleVoteOptions(state, play);
  return [...play.answers.values()]
    .sort(
      (firstAnswer, secondAnswer) =>
        firstAnswer.receivedAt - secondAnswer.receivedAt,
    )
    .flatMap((answer) => {
      const text = partyTextOf(answer);
      const isVisible =
        answer.hiddenAt === null && isPlayerActive(state, answer.playerId);
      if (text === null || !isVisible) return [];
      return [
        {
          optionId: answer.voteOptionId ?? answer.answerId,
          answerId: answer.answerId,
          authorPlayerId: answer.playerId,
          text,
          isTruth: false,
        },
      ];
    });
}

function votesDistribution(
  state: QuizshowLiveState,
  play: QuizshowLiveQuestionPlay,
): QuizshowDistribution {
  const votes = [...play.votes.values()];
  const entries = revealOptions(state, play).map(
    (option): QuizshowPartyRevealEntry => ({
      optionId: option.optionId,
      answerId: option.answerId,
      text: option.text,
      authorName: authorNameOf(state, option),
      isTruth: option.isTruth,
      voteCount: votes.filter((vote) => vote.optionId === option.optionId)
        .length,
      authorPoints:
        option.answerId === null
          ? 0
          : (answerById(play, option.answerId)?.pointsAwarded ?? 0),
    }),
  );
  const favouriteOptionId = entries.some(
    (entry) => entry.optionId === play.favouriteOptionId,
  )
    ? play.favouriteOptionId
    : null;
  return { kind: 'votes', entries, favouriteOptionId };
}

function buildDistribution(
  state: QuizshowLiveState,
  shown: QuizshowShownQuestion,
  play: QuizshowLiveQuestionPlay,
  eligiblePlayers: readonly QuizshowLivePlayer[],
): QuizshowDistribution {
  const answers = eligibleAnswersOf(play, eligiblePlayers);
  const question = shown.question;
  switch (question.type) {
    case 'multiple_choice':
    case 'poll':
      return optionsDistribution(question, answers);
    case 'true_false':
      return trueFalseDistribution(answers);
    case 'type_answer':
      return typedDistribution(answers);
    case 'order':
      return orderDistribution(shownAnswerKey(shown), answers);
    case 'closest_number':
      return closestDistribution(
        shownAnswerKey(shown),
        answers,
        eligiblePlayers,
      );
    case 'prompt':
      return votesDistribution(state, play);
  }
}

/** The question's reveal note while either language holds text; it rides `reveal` only, so the public never sees it before then. */
function revealNoteOf(question: QuizshowSnapshotQuestion): QuizshowText | null {
  const note = question.revealNote;
  return note.en === '' && note.pt === '' ? null : note;
}

/**
 * `reveal` in `reveal` and `scores`: the correct answer (a host correction
 * when one was made), the distribution with authors named by screen name, the
 * reveal note and whether a host corrected the question.
 */
export function buildReveal(state: QuizshowLiveState): QuizshowReveal | null {
  if (!REVEAL_PHASES.has(state.cursor.phase)) return null;
  const shown = shownQuestion(state);
  const play = shown?.play ?? null;
  if (shown === null || play === null) return null;
  const eligiblePlayers = eligiblePlayersNow(state);
  return {
    phaseId: revealPhaseId(state),
    questionId: play.questionId,
    correct: shownAnswerKey(shown),
    answeredCount: eligibleAnswersOf(play, eligiblePlayers).length,
    eligibleCount: eligiblePlayers.length,
    distribution: buildDistribution(state, shown, play, eligiblePlayers),
    note: revealNoteOf(shown.question),
    wasCorrected: play.wasCorrected,
  };
}

/**
 * `typed:answers` for hosts in `reveal` and `scores` of a type_answer
 * question (contract 6.4 rule 9): the eligible answers judged wrong, grouped
 * by the text the accept command compares, each with its earliest spelling,
 * most written first, at most 30 groups. Answers whose text normalises to ''
 * stay out of every group.
 */
export function buildTypedAnswers(
  state: QuizshowLiveState,
): QuizshowHostTypedAnswers | null {
  if (!REVEAL_PHASES.has(state.cursor.phase)) return null;
  const shown = shownQuestion(state);
  const play = shown?.play ?? null;
  if (shown === null || play === null) return null;
  if (shown.question.type !== 'type_answer') return null;
  const wrongAnswers = eligibleAnswersOf(play, eligiblePlayersNow(state))
    .filter((answer) => answer.isCorrect === false)
    .sort(
      (firstAnswer, secondAnswer) =>
        firstAnswer.receivedAt - secondAnswer.receivedAt,
    );
  const groupsByText = new Map<string, QuizshowTypedAnswerGroup>();
  for (const answer of wrongAnswers) {
    if (answer.payload.type !== 'type_answer') continue;
    const normalisedText = normaliseAnswerText(answer.payload.text);
    // Text that folds to nothing (punctuation or symbols alone) cannot be accepted, since the accept frame needs 1 to 80 characters.
    if (normalisedText === '') continue;
    const group = groupsByText.get(normalisedText);
    if (group === undefined) {
      groupsByText.set(normalisedText, {
        normalisedText,
        sampleText: answer.payload.text,
        count: 1,
      });
    } else {
      group.count += 1;
    }
  }
  const groups = [...groupsByText.values()]
    .sort(
      (firstGroup, secondGroup) =>
        secondGroup.count - firstGroup.count ||
        firstGroup.sampleText.localeCompare(secondGroup.sampleText, 'en'),
    )
    .slice(0, TYPED_ANSWER_GROUPS_MAX);
  return {
    phaseId: revealPhaseId(state),
    questionId: play.questionId,
    groups,
  };
}

/** The entrant a player competes as: themselves in solo play, their team in teams play. */
function entrantIdOf(
  state: QuizshowLiveState,
  player: QuizshowLivePlayer,
): string | null {
  return state.playMode === 'solo' ? player.playerId : player.teamId;
}

/**
 * `reveal:mine` for an eligible player still in the session, in `reveal` and
 * `scores`. A fan-out passes one `rankIndex` to every call (W1); without it
 * this call ranks on its own.
 */
export function buildMyReveal(
  state: QuizshowLiveState,
  playerId: string,
  rankIndex?: QuizshowRankIndex,
): QuizshowMyReveal | null {
  if (!REVEAL_PHASES.has(state.cursor.phase)) return null;
  const shown = shownQuestion(state);
  const play = shown?.play ?? null;
  const player = activePlayerOf(state, playerId);
  if (shown === null || play === null || player === null) return null;
  if (!play.eligiblePlayerIds.has(playerId)) return null;
  const answer = play.answers.get(playerId);
  // Party questions and polls are never judged right or wrong (contract 6.22).
  const isUnjudgedQuestion =
    shown.question.type === 'prompt' || shown.question.type === 'poll';
  const team =
    state.playMode === 'teams' && player.teamId !== null
      ? (state.teams.get(player.teamId) ?? null)
      : null;
  return {
    phaseId: revealPhaseId(state),
    questionId: play.questionId,
    hasAnswered: answer !== undefined,
    ownAnswerId: answer?.answerId ?? null,
    isCorrect: isUnjudgedQuestion ? null : (answer?.isCorrect ?? false),
    correctPositions:
      shown.question.type === 'order' && answer !== undefined
        ? (answer.correctPositions ??
          correctPositionsOf(shownAnswerKey(shown), answer))
        : null,
    pointsAwarded: play.pointsByPlayer.get(playerId) ?? 0,
    streakBonus: answer?.streakBonus ?? 0,
    isJokerActive: isJokerActiveFor(state, playerId, play.roundIndex),
    streak: player.streak,
    score: player.score,
    teamScore: state.playMode === 'teams' ? (team?.score ?? 0) : null,
    rank: rankOf(
      rankIndex ?? buildRankIndex(state),
      entrantIdOf(state, player),
    ),
  };
}

function scoresScopeOf(phase: QuizshowPhase): QuizshowScoresScope | null {
  switch (phase) {
    case 'scores':
      return 'question';
    case 'leaderboard':
      return 'round';
    case 'podium':
      return 'final';
    default:
      return null;
  }
}

/**
 * The entrant's score at the previous `scores` frame: from the frame this
 * phase recorded, else from the totals the last frame left behind; 0 when
 * absent.
 */
function previousScoreOf(state: QuizshowLiveState, entrantId: string): number {
  const lastScoresFrame = state.lastScoresFrame;
  if (
    lastScoresFrame !== null &&
    lastScoresFrame.phaseId === state.cursor.phaseId
  ) {
    return lastScoresFrame.previousByEntrant.get(entrantId) ?? 0;
  }
  return state.scoresAtLastFrame.get(entrantId) ?? 0;
}

/**
 * The leaderboard streak (contract 6.18): the player's own in solo play, the
 * best among a team's active members in teams play (0 with none). One pass
 * over the players per frame.
 */
function streaksByEntrant(state: QuizshowLiveState): Map<string, number> {
  const streaks = new Map<string, number>();
  for (const player of activePlayers(state)) {
    const entrantId = entrantIdOf(state, player);
    if (entrantId === null) continue;
    streaks.set(
      entrantId,
      Math.max(streaks.get(entrantId) ?? 0, player.streak),
    );
  }
  return streaks;
}

/** A podium place the host has not revealed yet; `revealedPlaces` is null outside the podium phase, where nothing is withheld. */
function isWithheldRank(
  rank: number,
  revealedPlaces: ReadonlySet<number> | null,
): boolean {
  return (
    revealedPlaces !== null && isPodiumPlace(rank) && !revealedPlaces.has(rank)
  );
}

/**
 * `scores` in `scores`, `leaderboard` and `podium`: the top of the
 * competition ranking. A fan-out passes one `rankIndex` (W1). During the
 * podium the public copy leaves out every podium place not revealed yet,
 * while hosts get every entry (contract 6.7).
 */
export function buildScores(
  state: QuizshowLiveState,
  rankIndex?: QuizshowRankIndex,
  audience: QuizshowFrameAudience = 'public',
): QuizshowScores | null {
  const scope = scoresScopeOf(state.cursor.phase);
  if (scope === null) return null;
  const { ranked } = rankIndex ?? buildRankIndex(state);
  const revealedPlaces =
    audience === 'hosts' ? null : revealedPodiumPlaces(state);
  const streaks = streaksByEntrant(state);
  return {
    phaseId: state.cursor.phaseId,
    scope,
    entries: ranked
      .slice(0, QUIZSHOW_LIMITS.leaderboardTopCount)
      .filter((entry) => !isWithheldRank(entry.rank, revealedPlaces))
      .map((entry): QuizshowLeaderboardEntry => ({
        rank: entry.rank,
        kind: entry.kind,
        entrantId: entry.entrantId,
        name: entry.name,
        colorKey: entry.colorKey,
        score: entry.score,
        previousScore: previousScoreOf(state, entry.entrantId),
        streak: streaks.get(entry.entrantId) ?? 0,
      })),
    entrantCount: ranked.length,
  };
}

/**
 * `scores:mine`: the player's rank and score (their team's in teams play) and
 * their own total. Null while the player's entrant sits on a podium place not
 * revealed yet (contract 6.7), so no phone learns its place early.
 */
export function buildMyScores(
  state: QuizshowLiveState,
  playerId: string,
  rankIndex?: QuizshowRankIndex,
): QuizshowMyScores | null {
  if (scoresScopeOf(state.cursor.phase) === null) return null;
  const player = activePlayerOf(state, playerId);
  if (player === null) return null;
  const entrantId = entrantIdOf(state, player);
  const rank = rankOf(rankIndex ?? buildRankIndex(state), entrantId);
  // Only a podium rank can be withheld, so most players skip the revealed-places lookup.
  if (
    isPodiumPlace(rank) &&
    isWithheldRank(rank, revealedPodiumPlaces(state))
  ) {
    return null;
  }
  return {
    phaseId: state.cursor.phaseId,
    rank,
    score: entrantScoreOf(state, player),
    previousScore: entrantId === null ? 0 : previousScoreOf(state, entrantId),
    ownScore: player.score,
  };
}

/** The score `entrantTotals` ranks the player's entrant by: their own in solo play, their team's in teams play (0 without a team). */
function entrantScoreOf(
  state: QuizshowLiveState,
  player: QuizshowLivePlayer,
): number {
  if (state.playMode === 'solo') return player.score;
  if (player.teamId === null) return 0;
  return state.teams.get(player.teamId)?.score ?? 0;
}

function isPodiumPlace(rank: number): rank is 1 | 2 | 3 {
  return rank === 1 || rank === 2 || rank === 3;
}

/** The stored podium (players gone since left out), or one ranked from the totals. */
function podiumEntries(
  state: QuizshowLiveState,
  rankIndex?: QuizshowRankIndex,
): QuizshowPodiumEntry[] {
  if (state.podium !== null) {
    return state.podium
      .filter(
        (entry) =>
          entry.kind === 'team' || isPlayerActive(state, entry.entrantId),
      )
      .map((entry) => ({ ...entry }));
  }
  const { ranked } = rankIndex ?? buildRankIndex(state);
  return ranked.flatMap((entry): QuizshowPodiumEntry[] =>
    isPodiumPlace(entry.rank)
      ? [
          {
            place: entry.rank,
            kind: entry.kind,
            entrantId: entry.entrantId,
            name: entry.name,
            colorKey: entry.colorKey,
            score: entry.score,
          },
        ]
      : [],
  );
}

/** Podium entries for the audience: in the podium phase the public sees revealed places only; hosts and `ended` see every entry. */
function podiumEntriesFor(
  state: QuizshowLiveState,
  audience: QuizshowFrameAudience,
  rankIndex?: QuizshowRankIndex,
): QuizshowPodiumEntry[] {
  const entries = podiumEntries(state, rankIndex);
  const revealedPlaces =
    audience === 'hosts' ? null : revealedPodiumPlaces(state);
  if (revealedPlaces === null) return entries;
  return entries.filter((entry) => revealedPlaces.has(entry.place));
}

/**
 * `podium` during the podium phase, one per audience (contract 6.7): the
 * screen and players get the places revealed so far, hosts every entry.
 * `revealedCount` falls back to every step for a podium shown without a
 * count.
 */
export function buildPodiumFrame(
  state: QuizshowLiveState,
  audience: QuizshowFrameAudience,
): QuizshowPodiumFrame | null {
  if (state.cursor.phase !== 'podium') return null;
  return {
    phaseId: state.cursor.phaseId,
    entries: podiumEntriesFor(state, audience),
    revealedCount:
      state.cursor.podiumRevealedCount ?? podiumSteps(state).length,
  };
}

/** The community support link, only on the `ended` state of a finished session that was not a practice (contract 6.27). */
function givingOf(state: QuizshowLiveState): QuizshowGivingLink | null {
  // The load already leaves `giving` null on a practice; this check holds even if a later load path forgets.
  return state.cursor.phase === 'ended' &&
    state.status === 'finished' &&
    !state.isPractice
    ? state.giving
    : null;
}

/** `session:end` to every room; results exist only for a finished session that was not a practice (contract 6.9). */
export function buildSessionEnd(state: QuizshowLiveState): QuizshowSessionEnd {
  const isFinished = state.status === 'finished';
  return {
    sessionId: state.sessionId,
    status: isFinished ? 'finished' : 'abandoned',
    podium: isFinished ? podiumEntries(state) : [],
    nextEvent: state.nextEvent,
    hasResults: isFinished && !state.isPractice,
    isPractice: state.isPractice,
    giving: givingOf(state),
  };
}

function sessionPodium(
  state: QuizshowLiveState,
  audience: QuizshowFrameAudience,
  rankIndex: QuizshowRankIndex,
): QuizshowPodiumEntry[] | null {
  if (state.cursor.phase === 'podium') {
    return podiumEntriesFor(state, audience, rankIndex);
  }
  if (state.cursor.phase === 'ended' && state.status === 'finished') {
    return podiumEntries(state, rankIndex);
  }
  return null;
}

/** Fields every role's `session:state` shares; `scores` and `podium` follow the audience's withholding (contract 6.7). */
function stateBase(
  state: QuizshowLiveState,
  audience: QuizshowFrameAudience,
  rankIndex: QuizshowRankIndex,
): QuizshowStateBase {
  return {
    sessionId: state.sessionId,
    eventSlug: state.eventSlug,
    eventTitle: state.eventTitle,
    kind: state.kind,
    gameId: state.gameId,
    isAdultsOnly: state.isAdultsOnly,
    joinCode: state.joinCode,
    quizTitle: state.snapshot.title,
    languages: state.snapshot.languages,
    screenLanguage: state.snapshot.screenLanguage,
    playMode: state.playMode,
    maxTeamSize: state.maxTeamSize,
    isReviewOn: state.isReviewOn,
    isPractice: state.isPractice,
    isJoinLocked: state.isJoinLocked,
    isAutoAdvanceOn: state.isAutoAdvanceOn,
    giving: givingOf(state),
    isScreenMuted: state.isScreenMuted,
    cursor: { ...state.cursor },
    rounds: state.snapshot.rounds.map((round, roundIndex) =>
      toRoundCard(round, roundIndex, state.playMode),
    ),
    round: currentRoundCard(state),
    reveal: buildReveal(state),
    scores: buildScores(state, rankIndex, audience),
    podium: sessionPodium(state, audience, rankIndex),
    nextEvent: state.cursor.phase === 'ended' ? state.nextEvent : null,
    wheel: wheelOf(state),
    wheelBonus: wheelBonusOf(state),
  };
}

function answerCountOf(
  state: QuizshowLiveState,
): { count: number; total: number } | null {
  const answerCount = buildAnswerCount(state);
  return answerCount === null
    ? null
    : { count: answerCount.count, total: answerCount.total };
}

/** One rank index serves the whole state (W1): `scores`, `podium`, `myReveal` and `myScores` all read it. */
function playerSessionState(
  state: QuizshowLiveState,
  viewer: { playerId: string | null; suggestedScreenName: string },
): QuizshowPlayerState {
  const rankIndex = buildRankIndex(state);
  const player = activePlayerOf(state, viewer.playerId);
  const shown = shownQuestion(state);
  const play = shown?.play ?? null;
  const answer =
    player === null || play === null
      ? undefined
      : play.answers.get(player.playerId);
  const vote =
    player === null || play === null
      ? undefined
      : play.votes.get(player.playerId);
  const myAnswer: QuizshowMyAnswer | null =
    answer === undefined
      ? null
      : {
          questionId: answer.questionId,
          phaseId: answer.phaseId,
          payload: answer.payload,
          receivedAt: answer.receivedAt,
        };
  const myVote: QuizshowMyVote | null =
    vote === undefined
      ? null
      : { questionId: vote.questionId, optionId: vote.optionId };
  return {
    ...stateBase(state, 'public', rankIndex),
    role: 'player',
    lobby: buildPlayerLobby(state),
    answerCount: answerCountOf(state),
    question: publicQuestionView(state),
    voteOptions:
      player === null
        ? buildVoteOptions(state, null)
        : buildVoteOptions(state, player.playerId),
    me: player === null ? null : toMe(state, player.playerId),
    suggestedScreenName: viewer.suggestedScreenName,
    // A question shown from the cursor alone (restart recovery) has no play yet; host:resume replays it for every active player.
    isEligibleForQuestion:
      player !== null &&
      (shown === null ||
        shown.play === null ||
        isEligible(state, player.playerId)),
    myAnswer,
    myVote,
    myReveal:
      player === null ? null : buildMyReveal(state, player.playerId, rankIndex),
    myScores:
      player === null ? null : buildMyScores(state, player.playerId, rankIndex),
  };
}

/** `session:state` for one attaching socket, filtered by role; every role carries `isScreenMuted`. */
export function buildSessionState(
  state: QuizshowLiveState,
  viewer: { role: 'screen' },
): QuizshowScreenState;
export function buildSessionState(
  state: QuizshowLiveState,
  viewer: { role: 'host' },
): QuizshowHostState;
export function buildSessionState(
  state: QuizshowLiveState,
  viewer: {
    role: 'player';
    playerId: string | null;
    suggestedScreenName: string;
  },
): QuizshowPlayerState;
export function buildSessionState(
  state: QuizshowLiveState,
  viewer: QuizshowSessionStateViewer,
): QuizshowSessionState;
export function buildSessionState(
  state: QuizshowLiveState,
  viewer: QuizshowSessionStateViewer,
): QuizshowSessionState {
  if (viewer.role === 'screen') {
    return {
      ...stateBase(state, 'public', buildRankIndex(state)),
      role: 'screen',
      lobby: buildLobby(state, 'screen'),
      question: publicQuestionView(state),
      answerCount: answerCountOf(state),
      voteOptions: buildVoteOptions(state, null),
    };
  }
  if (viewer.role === 'host') {
    return {
      ...stateBase(state, 'hosts', buildRankIndex(state)),
      role: 'host',
      lobby: buildHostLobby(state),
      question: hostQuestionView(state),
      answerCount: answerCountOf(state),
      voteOptions: buildHostVoteOptions(state),
      reviewList: buildReviewList(state),
      pairedDevices: buildPairedDevices(state),
      typedAnswers: buildTypedAnswers(state),
      guestPushSentAt: state.guestPushSentAt,
    };
  }
  return playerSessionState(state, viewer);
}
