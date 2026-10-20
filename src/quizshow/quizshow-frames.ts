/**
 * Pulse Live (`quizshow`) server to client frames and `session:state`, one
 * builder per frame and role. Pure: every builder only reads the live state.
 *
 * Privacy boundary: the screen and players see no answer key, truth or vote
 * count before `reveal`; no frame carries a user id, member slug or profile
 * name; `avatarUrl` reaches the screen and hosts only, while `isAvatarShown`.
 */
import {
  QUIZSHOW_LIMITS,
  type QuizshowDistribution,
  type QuizshowHostLobby,
  type QuizshowHostPlayer,
  type QuizshowHostQuestionView,
  type QuizshowHostState,
  type QuizshowHostTeam,
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
  type QuizshowPartyRevealEntry,
  type QuizshowPhase,
  type QuizshowPhaseChangeFrame,
  type QuizshowPlayerState,
  type QuizshowPodiumEntry,
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
  type QuizshowVoteOptions,
} from './quizshow.contract';
import {
  activePlayers,
  eligiblePlayersNow,
  entrantTotals,
  isEligible,
  isJokerActiveFor,
  toMe,
  type QuizshowEntrantTotal,
} from './quizshow-engine-state';
import type {
  QuizshowLiveAnswer,
  QuizshowLivePlayer,
  QuizshowLiveQuestionPlay,
  QuizshowLiveState,
  QuizshowLiveTeam,
  QuizshowLiveVoteOption,
} from './quizshow-engine-types';
import {
  closestNumberOutcomes,
  competitionRanks,
  type ClosestOutcome,
} from './quizshow-scoring';
import {
  toAnswerKeyView,
  toHostQuestionView,
  toQuestionView,
  toRoundCard,
  type QuizshowSnapshotQuestion,
  type QuizshowSnapshotRound,
} from './quizshow-snapshot';

export type QuizshowRoleRoom = 'screen' | 'players' | 'hosts';

export type QuizshowSessionStateViewer =
  | { role: 'screen' }
  | { role: 'host' }
  | { role: 'player'; playerId: string | null; suggestedScreenName: string };

export interface QuizshowAnswerCountFrame {
  phaseId: string;
  count: number;
  total: number;
}

export interface QuizshowPodiumFrame {
  phaseId: string;
  entries: QuizshowPodiumEntry[];
}

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
  );
}

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
  );
}

function currentRoundCard(state: QuizshowLiveState): QuizshowRoundCard | null {
  const { phase, roundIndex } = state.cursor;
  if (ROUNDLESS_PHASES.has(phase) || roundIndex === null) return null;
  const round = state.snapshot.rounds[roundIndex];
  return round === undefined ? null : toRoundCard(round, roundIndex);
}

function isPlayerActive(
  state: QuizshowLiveState,
  playerId: string | null,
): boolean {
  if (playerId === null) return false;
  const player = state.players.get(playerId);
  return player !== undefined && player.removedAt === null;
}

function activePlayerOf(
  state: QuizshowLiveState,
  playerId: string | null,
): QuizshowLivePlayer | null {
  if (playerId === null) return null;
  const player = state.players.get(playerId);
  return player !== undefined && player.removedAt === null ? player : null;
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

function toLobbyTeam(
  team: QuizshowLiveTeam,
  players: readonly QuizshowLivePlayer[],
): QuizshowLobbyTeam {
  return {
    teamId: team.teamId,
    name: team.name,
    colorKey: team.colorKey,
    memberCount: players.filter((player) => player.teamId === team.teamId)
      .length,
  };
}

/** `lobby:update` for the screen (with avatars) or the players room (avatars always null). */
export function buildLobby(
  state: QuizshowLiveState,
  audience: 'screen' | 'players',
): QuizshowLobby {
  const players = activePlayers(state);
  const isAvatarAudience = audience === 'screen';
  return {
    players: players.map((player) => toLobbyPlayer(player, isAvatarAudience)),
    teams: teamsInCreatedOrder(state).map((team) => toLobbyTeam(team, players)),
    playerCount: players.length,
  };
}

/** `lobby:update` for the hosts room: avatars, scores, jokers and connection state. */
export function buildHostLobby(state: QuizshowLiveState): QuizshowHostLobby {
  const players = activePlayers(state);
  return {
    players: players.map((player): QuizshowHostPlayer => ({
      ...toLobbyPlayer(player, true),
      isCohostPlayer: player.isCohostPlayer,
      hasExtraTime: player.hasExtraTime,
      hasUsedJoker: toMe(state, player.playerId).hasUsedJoker,
      score: player.score,
      isConnected: player.connectedSocketCount > 0,
      joinedAt: player.joinedAt,
    })),
    teams: teamsInCreatedOrder(state).map((team): QuizshowHostTeam => ({
      ...toLobbyTeam(team, players),
      score: team.score,
      hasUsedJoker: team.hasUsedJoker,
    })),
    playerCount: players.length,
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

function answerById(
  play: QuizshowLiveQuestionPlay,
  answerId: string,
): QuizshowLiveAnswer | undefined {
  return [...play.answers.values()].find(
    (answer) => answer.answerId === answerId,
  );
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

function visibleVoteOptions(
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

/** `vote:options` during `vote`: visible options with no author and no truth flag; `ownOptionId` is the receiving player's own answer. */
export function buildVoteOptions(
  state: QuizshowLiveState,
  forPlayerId: string | null,
): QuizshowVoteOptions | null {
  const play = votingPlay(state);
  if (play === null) return null;
  const options = visibleVoteOptions(state, play);
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

function correctPositionsOf(
  question: QuizshowSnapshotQuestion,
  answer: QuizshowLiveAnswer,
): number {
  if (question.type !== 'order' || answer.payload.type !== 'order') return 0;
  const orderedIds = question.answer?.orderedIds ?? [];
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

function multipleChoiceDistribution(
  question: QuizshowSnapshotQuestion,
  answers: readonly QuizshowLiveAnswer[],
): QuizshowDistribution {
  const shownOptions: readonly QuizshowOption[] =
    question.shownOptions ?? question.options;
  const counts = shownOptions.map(() => 0);
  for (const answer of answers) {
    if (answer.payload.type !== 'multiple_choice') continue;
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
  question: QuizshowSnapshotQuestion,
  answers: readonly QuizshowLiveAnswer[],
): QuizshowDistribution {
  const itemCount =
    question.type === 'order' ? (question.answer?.orderedIds.length ?? 0) : 0;
  let exactCount = 0;
  let partialCount = 0;
  let noneCount = 0;
  for (const answer of answers) {
    const correctPositions = correctPositionsOf(question, answer);
    if (itemCount > 0 && correctPositions === itemCount) exactCount += 1;
    else if (correctPositions > 0) partialCount += 1;
    else noneCount += 1;
  }
  return { kind: 'order', exactCount, partialCount, noneCount };
}

/** The closest players' names in joined order, the first one's value, and how many others landed inside the 10% band. */
function closestDistribution(
  question: QuizshowSnapshotQuestion,
  answers: readonly QuizshowLiveAnswer[],
  eligiblePlayers: readonly QuizshowLivePlayer[],
): QuizshowDistribution {
  const submittedValues = answers.flatMap((answer) =>
    answer.payload.type === 'closest_number'
      ? [{ playerId: answer.playerId, value: answer.payload.value }]
      : [],
  );
  const truth =
    question.type === 'closest_number'
      ? (question.answer?.value ?? null)
      : null;
  const outcomes =
    truth === null
      ? new Map<string, ClosestOutcome>()
      : closestNumberOutcomes(truth, submittedValues);
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
  question: QuizshowSnapshotQuestion,
  play: QuizshowLiveQuestionPlay,
  eligiblePlayers: readonly QuizshowLivePlayer[],
): QuizshowDistribution {
  const answers = eligibleAnswersOf(play, eligiblePlayers);
  switch (question.type) {
    case 'multiple_choice':
      return multipleChoiceDistribution(question, answers);
    case 'true_false':
      return trueFalseDistribution(answers);
    case 'type_answer':
      return typedDistribution(answers);
    case 'order':
      return orderDistribution(question, answers);
    case 'closest_number':
      return closestDistribution(question, answers, eligiblePlayers);
    case 'prompt':
      return votesDistribution(state, play);
  }
}

/** `reveal` in `reveal` and `scores`: the correct answer and the distribution, authors named by screen name. */
export function buildReveal(state: QuizshowLiveState): QuizshowReveal | null {
  if (!REVEAL_PHASES.has(state.cursor.phase)) return null;
  const shown = shownQuestion(state);
  const play = shown?.play ?? null;
  if (shown === null || play === null) return null;
  const eligiblePlayers = eligiblePlayersNow(state);
  return {
    phaseId: revealPhaseId(state),
    questionId: play.questionId,
    correct: toAnswerKeyView(shown.round, shown.question),
    answeredCount: eligibleAnswersOf(play, eligiblePlayers).length,
    eligibleCount: eligiblePlayers.length,
    distribution: buildDistribution(
      state,
      shown.question,
      play,
      eligiblePlayers,
    ),
  };
}

function rankedEntrants(
  state: QuizshowLiveState,
): Array<QuizshowEntrantTotal & { rank: number }> {
  return competitionRanks(entrantTotals(state));
}

/** The entrant a player competes as: themselves in solo play, their team in teams play. */
function entrantIdOf(
  state: QuizshowLiveState,
  player: QuizshowLivePlayer,
): string | null {
  return state.playMode === 'solo' ? player.playerId : player.teamId;
}

function rankOf(
  ranked: ReadonlyArray<QuizshowEntrantTotal & { rank: number }>,
  entrantId: string | null,
): number {
  const entry = ranked.find((ranking) => ranking.entrantId === entrantId);
  return entry?.rank ?? ranked.length + 1;
}

/** `reveal:mine` for an eligible player still in the session, in `reveal` and `scores`. */
export function buildMyReveal(
  state: QuizshowLiveState,
  playerId: string,
): QuizshowMyReveal | null {
  if (!REVEAL_PHASES.has(state.cursor.phase)) return null;
  const shown = shownQuestion(state);
  const play = shown?.play ?? null;
  const player = activePlayerOf(state, playerId);
  if (shown === null || play === null || player === null) return null;
  if (!play.eligiblePlayerIds.has(playerId)) return null;
  const answer = play.answers.get(playerId);
  const isPartyQuestion = shown.question.type === 'prompt';
  const team =
    state.playMode === 'teams' && player.teamId !== null
      ? (state.teams.get(player.teamId) ?? null)
      : null;
  return {
    phaseId: revealPhaseId(state),
    questionId: play.questionId,
    hasAnswered: answer !== undefined,
    ownAnswerId: answer?.answerId ?? null,
    isCorrect: isPartyQuestion ? null : (answer?.isCorrect ?? false),
    correctPositions:
      shown.question.type === 'order' && answer !== undefined
        ? (answer.correctPositions ??
          correctPositionsOf(shown.question, answer))
        : null,
    pointsAwarded: play.pointsByPlayer.get(playerId) ?? 0,
    streakBonus: answer?.streakBonus ?? 0,
    isJokerActive: isJokerActiveFor(state, playerId, play.roundIndex),
    streak: player.streak,
    score: player.score,
    teamScore: state.playMode === 'teams' ? (team?.score ?? 0) : null,
    rank: rankOf(rankedEntrants(state), entrantIdOf(state, player)),
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

/** `scores` in `scores`, `leaderboard` and `podium`: the top of the competition ranking. */
export function buildScores(state: QuizshowLiveState): QuizshowScores | null {
  const scope = scoresScopeOf(state.cursor.phase);
  if (scope === null) return null;
  const ranked = rankedEntrants(state);
  return {
    phaseId: state.cursor.phaseId,
    scope,
    entries: ranked
      .slice(0, QUIZSHOW_LIMITS.leaderboardTopCount)
      .map((entry): QuizshowLeaderboardEntry => ({
        rank: entry.rank,
        kind: entry.kind,
        entrantId: entry.entrantId,
        name: entry.name,
        colorKey: entry.colorKey,
        score: entry.score,
        previousScore: previousScoreOf(state, entry.entrantId),
      })),
    entrantCount: ranked.length,
  };
}

/** `scores:mine`: the player's rank and score (their team's in teams play) and their own total. */
export function buildMyScores(
  state: QuizshowLiveState,
  playerId: string,
): QuizshowMyScores | null {
  if (scoresScopeOf(state.cursor.phase) === null) return null;
  const player = activePlayerOf(state, playerId);
  if (player === null) return null;
  const ranked = rankedEntrants(state);
  const entrantId = entrantIdOf(state, player);
  const entry = ranked.find((ranking) => ranking.entrantId === entrantId);
  return {
    phaseId: state.cursor.phaseId,
    rank: rankOf(ranked, entrantId),
    score: entry?.score ?? 0,
    previousScore: entrantId === null ? 0 : previousScoreOf(state, entrantId),
    ownScore: player.score,
  };
}

function isPodiumPlace(rank: number): rank is 1 | 2 | 3 {
  return rank === 1 || rank === 2 || rank === 3;
}

/** The stored podium (players removed since left out), or one ranked from the totals. */
function podiumEntries(state: QuizshowLiveState): QuizshowPodiumEntry[] {
  if (state.podium !== null) {
    return state.podium
      .filter(
        (entry) =>
          entry.kind === 'team' || isPlayerActive(state, entry.entrantId),
      )
      .map((entry) => ({ ...entry }));
  }
  return rankedEntrants(state).flatMap((entry): QuizshowPodiumEntry[] =>
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

/** `podium` during the podium phase. */
export function buildPodiumFrame(
  state: QuizshowLiveState,
): QuizshowPodiumFrame | null {
  if (state.cursor.phase !== 'podium') return null;
  return { phaseId: state.cursor.phaseId, entries: podiumEntries(state) };
}

/** `session:end` to every room; results exist only for a finished session. */
export function buildSessionEnd(state: QuizshowLiveState): QuizshowSessionEnd {
  const isFinished = state.status === 'finished';
  return {
    sessionId: state.sessionId,
    status: isFinished ? 'finished' : 'abandoned',
    podium: isFinished ? podiumEntries(state) : [],
    nextEvent: state.nextEvent,
    hasResults: isFinished,
  };
}

function sessionPodium(state: QuizshowLiveState): QuizshowPodiumEntry[] | null {
  if (state.cursor.phase === 'podium') return podiumEntries(state);
  if (state.cursor.phase === 'ended' && state.status === 'finished') {
    return podiumEntries(state);
  }
  return null;
}

function stateBase(state: QuizshowLiveState): QuizshowStateBase {
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
    isScreenMuted: state.isScreenMuted,
    cursor: { ...state.cursor },
    rounds: state.snapshot.rounds.map((round, roundIndex) =>
      toRoundCard(round, roundIndex),
    ),
    round: currentRoundCard(state),
    reveal: buildReveal(state),
    scores: buildScores(state),
    podium: sessionPodium(state),
    nextEvent: state.cursor.phase === 'ended' ? state.nextEvent : null,
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

function playerSessionState(
  state: QuizshowLiveState,
  viewer: { playerId: string | null; suggestedScreenName: string },
): QuizshowPlayerState {
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
    ...stateBase(state),
    role: 'player',
    lobby: buildLobby(state, 'players'),
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
    myReveal: player === null ? null : buildMyReveal(state, player.playerId),
    myScores: player === null ? null : buildMyScores(state, player.playerId),
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
      ...stateBase(state),
      role: 'screen',
      lobby: buildLobby(state, 'screen'),
      question: publicQuestionView(state),
      answerCount: answerCountOf(state),
      voteOptions: buildVoteOptions(state, null),
    };
  }
  if (viewer.role === 'host') {
    return {
      ...stateBase(state),
      role: 'host',
      lobby: buildHostLobby(state),
      question: hostQuestionView(state),
      answerCount: answerCountOf(state),
      voteOptions: buildHostVoteOptions(state),
      reviewList: buildReviewList(state),
    };
  }
  return playerSessionState(state, viewer);
}
