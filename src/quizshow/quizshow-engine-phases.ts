/**
 * Pulse Live (`quizshow`) engine phases: the phase machine of one live
 * session. Host commands, timers, early closes, scoring at reveal, scores,
 * leaderboard and podium, the end of the night and abandonment. Pure: every
 * time comes in as a `now` argument and randomness through `QuizshowRandom`.
 */
import { textHasBlockedTerm } from '../common/blocked-terms';
import type { QuizshowStoredPodiumEntry } from './entities/quizshow-result.entity';
import {
  QUIZSHOW_LIMITS,
  QUIZSHOW_TIMED_PHASES,
  type QuizshowPhase,
  type QuizshowPodiumEntry,
  type QuizshowScoresScope,
  type QuizshowSessionStatus,
} from './quizshow.contract';
import {
  activePlayers,
  advanceCursor,
  eligiblePlayersNow,
  entrantTotals,
  isJokerActiveFor,
  ownDeadline,
  persist,
  refuse,
  setSessionStatus,
  succeed,
} from './quizshow-engine-state';
import type {
  QuizshowCommandOutcome,
  QuizshowEngineEffect,
  QuizshowLiveAnswer,
  QuizshowLiveQuestionPlay,
  QuizshowLiveState,
  QuizshowLiveVoteOption,
  QuizshowPersistOperation,
  QuizshowQuestionLogEntry,
} from './quizshow-engine-types';
import { isPartyRoundKind } from './quizshow-quiz-validation';
import {
  closestNumberOutcomes,
  competitionRanks,
  scoreLieDetectorVotes,
  scorePartyVotes,
  scoreQuizAnswer,
  teamQuestionPoints,
} from './quizshow-scoring';
import {
  CRYPTO_RANDOM,
  extraTimeMs,
  isLastQuestionOfRound,
  isLastRound,
  openLimitMs,
  shuffleAvoidingOrder,
  snapshotQuestionAt,
  toAnswerKeyView,
  voteLimitMs,
  writeLimitMs,
  type QuizshowRandom,
  type QuizshowSnapshotQuestion,
  type QuizshowSnapshotRound,
} from './quizshow-snapshot';

/** Host commands that move the cursor and share the no-op rule. */
export const QUIZSHOW_MOVING_COMMANDS = [
  'start',
  'next',
  'reveal',
  'skip',
  'show_answers',
  'end',
] as const;

export type QuizshowHostOutcome = QuizshowCommandOutcome<{ isNoop: boolean }>;

/** Phases that belong to one question before its reveal; a restart replays them. */
const QUESTION_PHASES: readonly QuizshowPhase[] = [
  'read',
  'open',
  'write',
  'review',
  'vote',
];

/** Phases that take answers or votes and close early once everyone is done. */
const SUBMISSION_PHASES: readonly QuizshowPhase[] = ['open', 'write', 'vote'];

const OPEN_STATUSES: readonly QuizshowSessionStatus[] = [
  'lobby',
  'running',
  'paused',
];

function isTimedPhase(phase: QuizshowPhase): boolean {
  return (QUIZSHOW_TIMED_PHASES as readonly QuizshowPhase[]).includes(phase);
}

function isOpenStatus(status: QuizshowSessionStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

function checkpoint(): QuizshowEngineEffect {
  return persist({ type: 'checkpoint' });
}

function isCheckpointEffect(effect: QuizshowEngineEffect): boolean {
  return effect.kind === 'persist' && effect.operation.type === 'checkpoint';
}

/** Keeps one checkpoint, at the end, when the effects hold any. */
function withSingleCheckpoint(
  effects: QuizshowEngineEffect[],
): QuizshowEngineEffect[] {
  if (!effects.some(isCheckpointEffect)) return effects;
  return [
    ...effects.filter((effect) => !isCheckpointEffect(effect)),
    checkpoint(),
  ];
}

/** Every host command attempt, refused or not, resets the abandonment clock: it measures host presence. */
function noteHostCommand(state: QuizshowLiveState, now: number): void {
  state.lastHostCommandAt = now;
}

/** A host command that acted or was a no-op: ends on one checkpoint. */
function hostActed(
  state: QuizshowLiveState,
  now: number,
  effects: QuizshowEngineEffect[],
  isNoop: boolean,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  return succeed({ isNoop }, [
    ...effects.filter((effect) => !isCheckpointEffect(effect)),
    checkpoint(),
  ]);
}

/** The no-op and stale rule shared by every moving command. */
function checkMovingCommand(
  state: QuizshowLiveState,
  phaseId: string,
): 'act' | 'noop' | 'stale' {
  if (phaseId === state.cursor.phaseId) return 'act';
  if (state.lastTransition?.fromPhaseId === phaseId) return 'noop';
  return 'stale';
}

interface QuizshowPlayContext {
  play: QuizshowLiveQuestionPlay;
  round: QuizshowSnapshotRound;
  question: QuizshowSnapshotQuestion;
}

/** The question in play with its round; a missing one breaks an engine invariant. */
function currentPlayContext(state: QuizshowLiveState): QuizshowPlayContext {
  const play = state.current;
  if (play === null) {
    throw new Error(
      `Pulse Live session ${state.sessionId} has no question in play.`,
    );
  }
  const round = state.snapshot.rounds[play.roundIndex];
  const question = round?.questions[play.questionIndex];
  if (round === undefined || question === undefined) {
    throw new Error(
      `Pulse Live session ${state.sessionId} names a question outside its snapshot.`,
    );
  }
  return { play, round, question };
}

function isQuizRoundInPlay(state: QuizshowLiveState): boolean {
  const roundIndex = state.cursor.roundIndex ?? state.current?.roundIndex;
  if (roundIndex === undefined) return false;
  const round = state.snapshot.rounds[roundIndex];
  return round !== undefined && !isPartyRoundKind(round.kind);
}

function findLogEntry(
  state: QuizshowLiveState,
  questionId: string,
): QuizshowQuestionLogEntry | undefined {
  for (let index = state.questionLog.length - 1; index >= 0; index -= 1) {
    const entry = state.questionLog[index];
    if (entry !== undefined && entry.questionId === questionId) return entry;
  }
  return undefined;
}

function findAnswer(
  play: QuizshowLiveQuestionPlay,
  answerId: string,
): QuizshowLiveAnswer | undefined {
  return [...play.answers.values()].find(
    (answer) => answer.answerId === answerId,
  );
}

function isOptionVisible(
  play: QuizshowLiveQuestionPlay,
  option: QuizshowLiveVoteOption,
): boolean {
  if (option.answerId === null) return true;
  return findAnswer(play, option.answerId)?.hiddenAt === null;
}

/** The timer of the current timed phase: `read` fires at its deadline, the others after the answer grace. */
function phaseTimer(state: QuizshowLiveState): QuizshowEngineEffect[] {
  const { deadline, phase, phaseId } = state.cursor;
  if (deadline === null) return [];
  const fireAt =
    phase === 'read' ? deadline : deadline + QUIZSHOW_LIMITS.answerGraceMs;
  return [{ kind: 'timer', phaseId, fireAt }];
}

/** Eligible, still active, and without an answer (`open`, `write`) or a vote (`vote`) for the current question. */
function isStillToSubmit(state: QuizshowLiveState, playerId: string): boolean {
  const play = state.current;
  if (play === null || !play.eligiblePlayerIds.has(playerId)) return false;
  const player = state.players.get(playerId);
  if (player === undefined || player.removedAt !== null) return false;
  return state.cursor.phase === 'vote'
    ? !play.votes.has(playerId)
    : !play.answers.has(playerId);
}

/** Still to submit and still allowed to: their own deadline plus the grace has not passed (the players engine refuses them after it). */
function isAwaitedSubmitter(
  state: QuizshowLiveState,
  playerId: string,
  now: number,
): boolean {
  if (!isStillToSubmit(state, playerId)) return false;
  const deadline = ownDeadline(state, playerId);
  return deadline === null || now <= deadline + QUIZSHOW_LIMITS.answerGraceMs;
}

/** Opens a question at its first phase and freezes who may play it. */
function openQuestion(
  state: QuizshowLiveState,
  roundIndex: number,
  questionIndex: number,
  now: number,
): QuizshowEngineEffect[] {
  const round = state.snapshot.rounds[roundIndex];
  const question = round?.questions[questionIndex];
  if (round === undefined || question === undefined) {
    throw new Error(
      `Pulse Live session ${state.sessionId} has no question ${roundIndex}.${questionIndex}.`,
    );
  }
  const eligiblePlayers = activePlayers(state);
  state.current = {
    questionId: question.id,
    roundIndex,
    questionIndex,
    openedAt: now,
    eligiblePlayerIds: new Set(
      eligiblePlayers.map((player) => player.playerId),
    ),
    extraTimePlayerIds: new Set(
      eligiblePlayers
        .filter((player) => player.hasExtraTime)
        .map((player) => player.playerId),
    ),
    answers: new Map(),
    votes: new Map(),
    voteOptions: null,
    favouriteOptionId: null,
    isScored: false,
    wasSkipped: false,
    pointsByPlayer: new Map(),
    teamPoints: new Map(),
  };
  state.questionLog.push({
    questionId: question.id,
    roundIndex,
    questionIndex,
    roundKind: round.kind,
    type: question.type,
    openedAt: now,
    revealedAt: null,
    eligibleCount: eligiblePlayers.length,
    wasSkipped: false,
  });
  const isParty = isPartyRoundKind(round.kind);
  const limitMs = isParty ? writeLimitMs(round) : QUIZSHOW_LIMITS.readPhaseMs;
  advanceCursor(state, {
    phase: isParty ? 'write' : 'read',
    roundIndex,
    questionIndex,
    now,
    durationMs: limitMs,
    extraTimeMs: isParty ? extraTimeMs(limitMs) : null,
  });
  return [
    { kind: 'phase_changed' },
    { kind: 'answer_count_changed' },
    ...phaseTimer(state),
    checkpoint(),
  ];
}

/** `read` to `open` with the question's limit and its extra time. */
function openAnswers(
  state: QuizshowLiveState,
  now: number,
): QuizshowEngineEffect[] {
  const { play, round, question } = currentPlayContext(state);
  const limitMs = openLimitMs(round, question);
  advanceCursor(state, {
    phase: 'open',
    roundIndex: play.roundIndex,
    questionIndex: play.questionIndex,
    now,
    durationMs: limitMs,
    extraTimeMs: extraTimeMs(limitMs),
  });
  return [{ kind: 'phase_changed' }, ...phaseTimer(state), checkpoint()];
}

function openRoundIntro(
  state: QuizshowLiveState,
  roundIndex: number,
  now: number,
): QuizshowEngineEffect[] {
  advanceCursor(state, {
    phase: 'round_intro',
    roundIndex,
    questionIndex: null,
    now,
    durationMs: null,
    extraTimeMs: null,
  });
  return [{ kind: 'phase_changed' }, checkpoint()];
}

function totalsByEntrant(state: QuizshowLiveState): Map<string, number> {
  return new Map(
    entrantTotals(state).map((entrant) => [entrant.entrantId, entrant.score]),
  );
}

/** Remembers the frame's previous scores, then the totals it shows. */
function recordScoresFrame(
  state: QuizshowLiveState,
  scope: QuizshowScoresScope,
): void {
  state.lastScoresFrame = {
    phaseId: state.cursor.phaseId,
    scope,
    previousByEntrant: new Map(state.scoresAtLastFrame),
  };
  state.scoresAtLastFrame = totalsByEntrant(state);
}

/** `scores` keeps the question's indices; `leaderboard` keeps the round that ended. */
function showScores(
  state: QuizshowLiveState,
  phase: 'scores' | 'leaderboard',
  scope: QuizshowScoresScope,
  now: number,
): QuizshowEngineEffect[] {
  const { roundIndex, questionIndex } = state.cursor;
  advanceCursor(state, {
    phase,
    roundIndex,
    questionIndex: phase === 'scores' ? questionIndex : null,
    now,
    durationMs: null,
    extraTimeMs: null,
  });
  recordScoresFrame(state, scope);
  return [
    { kind: 'phase_changed' },
    { kind: 'scores_shown', scope },
    checkpoint(),
  ];
}

function podiumPlaceOf(rank: number): 1 | 2 | 3 | null {
  return rank === 1 || rank === 2 || rank === 3 ? rank : null;
}

/** Every entrant ranked 3 or better, ties sharing a place. */
function buildPodium(state: QuizshowLiveState): QuizshowPodiumEntry[] {
  return competitionRanks(entrantTotals(state)).flatMap(
    (entry): QuizshowPodiumEntry[] => {
      const place = podiumPlaceOf(entry.rank);
      if (place === null) return [];
      return [
        {
          place,
          kind: entry.kind,
          entrantId: entry.entrantId,
          name: entry.name,
          colorKey: entry.colorKey,
          score: entry.score,
        },
      ];
    },
  );
}

/** Every active player's place: their own in solo play, their team's in teams play. */
function buildPlacings(state: QuizshowLiveState): Record<string, number> {
  const rankByEntrant = new Map(
    competitionRanks(entrantTotals(state)).map((entry) => [
      entry.entrantId,
      entry.rank,
    ]),
  );
  const placings: Record<string, number> = {};
  for (const player of activePlayers(state)) {
    const entrantId =
      state.playMode === 'solo' ? player.playerId : player.teamId;
    const rank = entrantId === null ? undefined : rankByEntrant.get(entrantId);
    if (rank !== undefined) placings[player.playerId] = rank;
  }
  return placings;
}

function showPodium(
  state: QuizshowLiveState,
  now: number,
): QuizshowEngineEffect[] {
  state.status = 'running';
  state.pausedAt = null;
  advanceCursor(state, {
    phase: 'podium',
    roundIndex: null,
    questionIndex: null,
    now,
    durationMs: null,
    extraTimeMs: null,
  });
  recordScoresFrame(state, 'final');
  state.podium = buildPodium(state);
  return [
    { kind: 'phase_changed' },
    // host:end can arrive from a timed phase; the podium has no deadline.
    { kind: 'timer_cleared' },
    { kind: 'scores_shown', scope: 'final' },
    { kind: 'podium_shown' },
    checkpoint(),
  ];
}

/** On the podium a removal or a withdrawal reorders it; anywhere else nothing to do. */
function refreshPodiumIfShown(
  state: QuizshowLiveState,
): QuizshowEngineEffect[] {
  if (state.cursor.phase !== 'podium') return [];
  state.podium = buildPodium(state);
  return [{ kind: 'podium_shown' }];
}

/** After a question's last phase: next question, the round's leaderboard, or the podium. */
function afterQuestion(
  state: QuizshowLiveState,
  now: number,
): QuizshowEngineEffect[] {
  const roundIndex = state.cursor.roundIndex ?? state.current?.roundIndex;
  const questionIndex =
    state.cursor.questionIndex ?? state.current?.questionIndex;
  if (roundIndex === undefined || questionIndex === undefined) {
    throw new Error(
      `Pulse Live session ${state.sessionId} moved on with no question in play.`,
    );
  }
  if (!isLastQuestionOfRound(state.snapshot, roundIndex, questionIndex)) {
    return openQuestion(state, roundIndex, questionIndex + 1, now);
  }
  if (!isLastRound(state.snapshot, roundIndex)) {
    return showScores(state, 'leaderboard', 'round', now);
  }
  return showPodium(state, now);
}

function finishSession(
  state: QuizshowLiveState,
  now: number,
): QuizshowEngineEffect[] {
  const podium = buildPodium(state);
  const placings = buildPlacings(state);
  state.podium = podium;
  state.pausedAt = null;
  state.status = 'finished';
  advanceCursor(state, {
    phase: 'ended',
    roundIndex: null,
    questionIndex: null,
    now,
    durationMs: null,
    extraTimeMs: null,
  });
  const storedPodium = podium.map((entry): QuizshowStoredPodiumEntry => ({
    place: entry.place,
    kind: entry.kind,
    entrantId: entry.entrantId,
    score: entry.score,
  }));
  return [
    { kind: 'phase_changed' },
    checkpoint(),
    persist({ type: 'finish', podium: storedPodium, placings }),
    { kind: 'timer_cleared' },
    { kind: 'session_ended', status: 'finished' },
  ];
}

/** Ends the session with no results, whatever its phase and scores. */
function abandonSession(
  state: QuizshowLiveState,
  now: number,
): QuizshowEngineEffect[] {
  state.pausedAt = null;
  state.status = 'abandoned';
  advanceCursor(state, {
    phase: 'ended',
    roundIndex: null,
    questionIndex: null,
    now,
    durationMs: null,
    extraTimeMs: null,
  });
  return [
    { kind: 'phase_changed' },
    checkpoint(),
    persist({ type: 'abandon' }),
    { kind: 'timer_cleared' },
    { kind: 'session_ended', status: 'abandoned' },
  ];
}

/** Team points over the members present when the question opened (one removed since counts 0), each team's total moved by the difference. */
function applyTeamPoints(
  state: QuizshowLiveState,
  play: QuizshowLiveQuestionPlay,
): void {
  if (state.playMode === 'solo') return;
  const openingMembers = [...play.eligiblePlayerIds].flatMap((playerId) => {
    const teamId = state.players.get(playerId)?.teamId ?? null;
    return teamId === null ? [] : [{ playerId, teamId }];
  });
  const nextTeamPoints = teamQuestionPoints(
    openingMembers,
    play.pointsByPlayer,
  );
  const teamIds = new Set([
    ...play.teamPoints.keys(),
    ...nextTeamPoints.keys(),
  ]);
  for (const teamId of teamIds) {
    const team = state.teams.get(teamId);
    if (team === undefined) continue;
    team.score +=
      (nextTeamPoints.get(teamId) ?? 0) - (play.teamPoints.get(teamId) ?? 0);
  }
  play.teamPoints = nextTeamPoints;
}

function scoreQuizQuestion(
  state: QuizshowLiveState,
  { play, round, question }: QuizshowPlayContext,
): void {
  const answerKey = toAnswerKeyView(round, question);
  const eligiblePlayers = eligiblePlayersNow(state);
  const limitMs = openLimitMs(round, question);
  const closestOutcomes =
    answerKey?.type === 'closest_number'
      ? closestNumberOutcomes(
          answerKey.value,
          eligiblePlayers.flatMap((player) => {
            const payload = play.answers.get(player.playerId)?.payload;
            return payload?.type === 'closest_number'
              ? [{ playerId: player.playerId, value: payload.value }]
              : [];
          }),
        )
      : null;
  for (const player of eligiblePlayers) {
    if (answerKey === null || question.type === 'prompt') {
      play.pointsByPlayer.set(player.playerId, 0);
      continue;
    }
    const answer = play.answers.get(player.playerId) ?? null;
    const score = scoreQuizAnswer({
      type: question.type,
      base: question.points,
      answerKey,
      payload: answer?.payload ?? null,
      elapsedMs: answer?.elapsedMs ?? 0,
      ownLimitMs: play.extraTimePlayerIds.has(player.playerId)
        ? extraTimeMs(limitMs)
        : limitMs,
      isSpeedBonusOn: round.settings.isSpeedBonusOn,
      streakBefore: player.streak,
      isJokerActive: isJokerActiveFor(state, player.playerId, play.roundIndex),
      closestOutcome: closestOutcomes?.get(player.playerId) ?? null,
    });
    if (answer !== null) {
      answer.isCorrect = score.isCorrect;
      answer.correctPositions = score.correctPositions;
      answer.pointsAwarded = score.pointsAwarded;
      answer.streakBonus = score.streakBonus;
    }
    player.score += score.pointsAwarded;
    player.streak = score.streakAfter;
    play.pointsByPlayer.set(player.playerId, score.pointsAwarded);
  }
}

/** Votes for visible options only; each author's share lands on their answer, every total on the player. */
function scorePartyQuestion(
  state: QuizshowLiveState,
  { play, round }: QuizshowPlayContext,
): void {
  const visibleOptions = new Map(
    (play.voteOptions ?? [])
      .filter((option) => isOptionVisible(play, option))
      .map((option) => [option.optionId, option]),
  );
  const countedVotes = [...play.votes.values()].flatMap((vote) => {
    const option = visibleOptions.get(vote.optionId);
    const isVoterRemoved =
      (state.players.get(vote.voterPlayerId)?.removedAt ?? null) !== null;
    return option === undefined || isVoterRemoved
      ? []
      : [
          {
            voterPlayerId: vote.voterPlayerId,
            authorPlayerId: option.authorPlayerId,
          },
        ];
  });
  const authoredVotes = countedVotes.flatMap((vote) =>
    vote.authorPlayerId === null
      ? []
      : [
          {
            voterPlayerId: vote.voterPlayerId,
            authorPlayerId: vote.authorPlayerId,
          },
        ],
  );
  const isJokerActive = (playerId: string): boolean =>
    isJokerActiveFor(state, playerId, play.roundIndex);
  const isLieDetector = round.kind === 'lie_detector';
  const totals = isLieDetector
    ? scoreLieDetectorVotes({
        votes: countedVotes,
        isJokerActiveFor: isJokerActive,
      })
    : scorePartyVotes({
        votes: authoredVotes,
        favouriteAuthorPlayerId: null,
        isJokerActiveFor: isJokerActive,
      });
  const authorShares = isLieDetector
    ? scoreLieDetectorVotes({
        votes: authoredVotes,
        isJokerActiveFor: isJokerActive,
      })
    : totals;
  for (const answer of play.answers.values()) {
    answer.pointsAwarded =
      answer.hiddenAt === null ? (authorShares.get(answer.playerId) ?? 0) : 0;
  }
  for (const player of eligiblePlayersNow(state)) {
    const points = totals.get(player.playerId) ?? 0;
    player.score += points;
    play.pointsByPlayer.set(player.playerId, points);
  }
}

function saveScoringOperation(
  state: QuizshowLiveState,
  play: QuizshowLiveQuestionPlay,
): QuizshowPersistOperation {
  return {
    type: 'save_scoring',
    questionId: play.questionId,
    answers: [...play.answers.values()].map((answer) => ({
      answerId: answer.answerId,
      isCorrect: answer.isCorrect,
      pointsAwarded: answer.pointsAwarded,
    })),
    players: [...play.pointsByPlayer.keys()].flatMap((playerId) => {
      const player = state.players.get(playerId);
      return player === undefined
        ? []
        : [{ playerId, score: player.score, streak: player.streak }];
    }),
    teams: [...state.teams.values()].map((team) => ({
      teamId: team.teamId,
      score: team.score,
    })),
  };
}

/** Scores the question once, then shows its reveal. */
function revealQuestion(
  state: QuizshowLiveState,
  now: number,
): QuizshowEngineEffect[] {
  const context = currentPlayContext(state);
  const { play, round } = context;
  if (!play.isScored) {
    if (isPartyRoundKind(round.kind)) scorePartyQuestion(state, context);
    else scoreQuizQuestion(state, context);
    applyTeamPoints(state, play);
    play.isScored = true;
  }
  const logEntry = findLogEntry(state, play.questionId);
  if (logEntry !== undefined) logEntry.revealedAt = now;
  state.hasScoredQuestion = true;
  advanceCursor(state, {
    phase: 'reveal',
    roundIndex: play.roundIndex,
    questionIndex: play.questionIndex,
    now,
    durationMs: null,
    extraTimeMs: null,
  });
  return [
    { kind: 'phase_changed' },
    { kind: 'revealed' },
    persist(saveScoringOperation(state, play)),
    checkpoint(),
  ];
}

function visibleAnswers(play: QuizshowLiveQuestionPlay): QuizshowLiveAnswer[] {
  return [...play.answers.values()]
    .filter((answer) => answer.hiddenAt === null)
    .sort((first, second) => first.receivedAt - second.receivedAt);
}

/** The Lie Detector truth in the screen language, the other language when that one is blank. */
function truthText(
  state: QuizshowLiveState,
  question: QuizshowSnapshotQuestion,
): string | null {
  if (question.type !== 'prompt' || question.answer === null) return null;
  const { truth } = question.answer;
  const screenText = truth[state.snapshot.screenLanguage].trim();
  if (screenText !== '') return screenText;
  const otherText = (
    state.snapshot.screenLanguage === 'en' ? truth.pt : truth.en
  ).trim();
  return otherText === '' ? null : otherText;
}

/** Vote options from the visible answers (the truth too on Lie Detector), each with a fresh id, shuffled. */
function startVote(
  state: QuizshowLiveState,
  now: number,
  random: QuizshowRandom,
): QuizshowEngineEffect[] {
  const context = currentPlayContext(state);
  const { play, round, question } = context;
  const answerOptions = visibleAnswers(play).map(
    (answer): QuizshowLiveVoteOption & { answerId: string } => {
      const optionId = random.uuid();
      answer.voteOptionId = optionId;
      return {
        optionId,
        answerId: answer.answerId,
        authorPlayerId: answer.playerId,
        text: answer.payload.type === 'prompt' ? answer.payload.text : '',
        isTruth: false,
      };
    },
  );
  const options: QuizshowLiveVoteOption[] = [...answerOptions];
  const truth =
    round.kind === 'lie_detector' ? truthText(state, question) : null;
  if (truth !== null) {
    options.push({
      optionId: random.uuid(),
      answerId: null,
      authorPlayerId: null,
      text: truth,
      isTruth: true,
    });
  }
  // An empty correct order makes this a plain Fisher-Yates shuffle.
  play.voteOptions = shuffleAvoidingOrder(options, [], random);
  const effects: QuizshowEngineEffect[] = [
    persist({
      type: 'set_answer_vote_options',
      options: answerOptions.map((option) => ({
        answerId: option.answerId,
        voteOptionId: option.optionId,
      })),
    }),
  ];
  if (play.voteOptions.length < 2) {
    return [...effects, ...revealQuestion(state, now)];
  }
  const limitMs = voteLimitMs(round);
  advanceCursor(state, {
    phase: 'vote',
    roundIndex: play.roundIndex,
    questionIndex: play.questionIndex,
    now,
    durationMs: limitMs,
    extraTimeMs: extraTimeMs(limitMs),
  });
  return [
    ...effects,
    { kind: 'phase_changed' },
    { kind: 'vote_options_shown' },
    { kind: 'answer_count_changed' },
    ...phaseTimer(state),
    checkpoint(),
  ];
}

/** `review` when it is on and something is visible to check, else straight to the vote. */
function afterWrite(
  state: QuizshowLiveState,
  now: number,
  random: QuizshowRandom,
): QuizshowEngineEffect[] {
  const { play } = currentPlayContext(state);
  if (state.isReviewOn && visibleAnswers(play).length >= 1) {
    advanceCursor(state, {
      phase: 'review',
      roundIndex: play.roundIndex,
      questionIndex: play.questionIndex,
      now,
      durationMs: null,
      extraTimeMs: null,
    });
    return [
      { kind: 'phase_changed' },
      { kind: 'review_list_changed' },
      { kind: 'answer_count_changed' },
      checkpoint(),
    ];
  }
  return startVote(state, now, random);
}

/** A timed phase reached its deadline plus grace: wait for extra-time players, or move on. */
function closeTimedPhase(
  state: QuizshowLiveState,
  now: number,
  shouldWaitForExtraTime: boolean,
  random: QuizshowRandom,
): QuizshowEngineEffect[] {
  const { extraTimeDeadline, phaseId } = state.cursor;
  const extraTimePlayerIds =
    state.current?.extraTimePlayerIds ?? new Set<string>();
  if (
    shouldWaitForExtraTime &&
    extraTimeDeadline !== null &&
    now < extraTimeDeadline + QUIZSHOW_LIMITS.answerGraceMs &&
    [...extraTimePlayerIds].some((playerId) =>
      isAwaitedSubmitter(state, playerId, now),
    )
  ) {
    return [
      {
        kind: 'timer',
        phaseId,
        fireAt: extraTimeDeadline + QUIZSHOW_LIMITS.answerGraceMs,
      },
    ];
  }
  if (state.cursor.phase === 'write') return afterWrite(state, now, random);
  return revealQuestion(state, now);
}

/** Hides one answer of the question in play and withdraws what it earned once scored. */
function hideAnswerInPlay(
  state: QuizshowLiveState,
  play: QuizshowLiveQuestionPlay,
  answer: QuizshowLiveAnswer,
  now: number,
): QuizshowEngineEffect[] {
  answer.hiddenAt = now;
  if (state.cursor.phase === 'review') return [{ kind: 'review_list_changed' }];
  if (play.voteOptions === null) return [];
  const option = play.voteOptions.find(
    (voteOption) => voteOption.answerId === answer.answerId,
  );
  if (option !== undefined && play.favouriteOptionId === option.optionId) {
    play.favouriteOptionId = null;
  }
  const effects: QuizshowEngineEffect[] = [
    {
      kind: 'answer_hidden',
      questionId: play.questionId,
      answerId: answer.answerId,
      optionId: option?.optionId ?? null,
    },
  ];
  if (!play.isScored) return effects;
  const withdrawnPoints = answer.pointsAwarded;
  const author = state.players.get(answer.playerId);
  if (author !== undefined) author.score -= withdrawnPoints;
  if (play.pointsByPlayer.has(answer.playerId)) {
    play.pointsByPlayer.set(
      answer.playerId,
      (play.pointsByPlayer.get(answer.playerId) ?? 0) - withdrawnPoints,
    );
  }
  answer.pointsAwarded = 0;
  applyTeamPoints(state, play);
  effects.push(persist(saveScoringOperation(state, play)), {
    kind: 'reveal_updated',
    favouriteAuthorPlayerId: null,
  });
  const shownScoresScope = scoresScopeShownIn(state.cursor.phase);
  if (shownScoresScope !== null) {
    // The scores on show already counted the withdrawn points: send them again with the new totals.
    state.scoresAtLastFrame = totalsByEntrant(state);
    effects.push({ kind: 'scores_shown', scope: shownScoresScope });
  }
  return effects;
}

/** The scores scope a phase shows, or null for a phase with no scores on show. */
function scoresScopeShownIn(phase: QuizshowPhase): QuizshowScoresScope | null {
  if (phase === 'scores') return 'question';
  if (phase === 'leaderboard') return 'round';
  if (phase === 'podium') return 'final';
  return null;
}

function isPromptQuestionInPlay(
  state: QuizshowLiveState,
  play: QuizshowLiveQuestionPlay,
): boolean {
  const question = snapshotQuestionAt(
    state.snapshot,
    play.roundIndex,
    play.questionIndex,
  );
  return question !== null && question.type === 'prompt';
}

export function hostStart(
  state: QuizshowLiveState,
  phaseId: string,
  now: number,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  const movingCheck = checkMovingCommand(state, phaseId);
  if (movingCheck === 'stale')
    return refuse('quizshow_stale_phase', state, true);
  if (movingCheck === 'noop') return hostActed(state, now, [], true);
  if (state.status !== 'lobby') {
    return refuse('quizshow_command_not_allowed', state, true);
  }
  const players = activePlayers(state);
  if (players.length === 0) return refuse('quizshow_no_players', state, false);
  const effects: QuizshowEngineEffect[] = [];
  const emptyTeamIds = [...state.teams.values()]
    .filter((team) => !players.some((player) => player.teamId === team.teamId))
    .map((team) => team.teamId);
  if (emptyTeamIds.length > 0) {
    for (const teamId of emptyTeamIds) state.teams.delete(teamId);
    effects.push(persist({ type: 'delete_teams', teamIds: emptyTeamIds }), {
      kind: 'lobby_changed',
    });
  }
  state.status = 'running';
  effects.push(...openRoundIntro(state, 0, now));
  return hostActed(state, now, effects, false);
}

/** What `host:next` does in the current phase; null where it is not allowed. */
function nextEffects(
  state: QuizshowLiveState,
  now: number,
  random: QuizshowRandom,
): QuizshowEngineEffect[] | null {
  const { phase, roundIndex } = state.cursor;
  switch (phase) {
    case 'round_intro':
      return roundIndex === null
        ? null
        : openQuestion(state, roundIndex, 0, now);
    case 'read':
      return openAnswers(state, now);
    case 'open':
    case 'write':
    case 'vote':
      return closeTimedPhase(state, now, false, random);
    case 'review':
      return startVote(state, now, random);
    case 'reveal':
      return isQuizRoundInPlay(state)
        ? showScores(state, 'scores', 'question', now)
        : afterQuestion(state, now);
    case 'scores':
      return afterQuestion(state, now);
    case 'leaderboard':
      return roundIndex === null
        ? null
        : openRoundIntro(state, roundIndex + 1, now);
    case 'podium':
      return finishSession(state, now);
    default:
      return null;
  }
}

export function hostNext(
  state: QuizshowLiveState,
  phaseId: string,
  now: number,
  random: QuizshowRandom = CRYPTO_RANDOM,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  const movingCheck = checkMovingCommand(state, phaseId);
  if (movingCheck === 'stale')
    return refuse('quizshow_stale_phase', state, true);
  if (movingCheck === 'noop') return hostActed(state, now, [], true);
  if (state.status !== 'running') {
    return refuse('quizshow_command_not_allowed', state, true);
  }
  const effects = nextEffects(state, now, random);
  if (effects === null)
    return refuse('quizshow_command_not_allowed', state, true);
  return hostActed(state, now, effects, false);
}

export function hostPause(
  state: QuizshowLiveState,
  phaseId: string,
  now: number,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  if (phaseId !== state.cursor.phaseId) {
    return refuse('quizshow_stale_phase', state, true);
  }
  if (state.status === 'paused') return hostActed(state, now, [], true);
  const { cursor } = state;
  if (
    state.status !== 'running' ||
    cursor.phase === 'lobby' ||
    cursor.phase === 'ended'
  ) {
    return refuse('quizshow_command_not_allowed', state, true);
  }
  const effects: QuizshowEngineEffect[] = [{ kind: 'phase_changed' }];
  state.pausedAt = now;
  if (isTimedPhase(cursor.phase) && cursor.deadline !== null) {
    // Signed: a pause past the deadline keeps the overrun, so no fresh grace after resume.
    cursor.pausedRemainingMs = cursor.deadline - now;
    cursor.pausedExtraTimeRemainingMs =
      cursor.extraTimeDeadline === null ? null : cursor.extraTimeDeadline - now;
    cursor.deadline = null;
    cursor.extraTimeDeadline = null;
    effects.push({ kind: 'timer_cleared' });
  }
  setSessionStatus(state, 'paused');
  return hostActed(state, now, effects, false);
}

export function hostResume(
  state: QuizshowLiveState,
  phaseId: string,
  now: number,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  if (phaseId !== state.cursor.phaseId) {
    return refuse('quizshow_stale_phase', state, true);
  }
  if (state.status === 'running') return hostActed(state, now, [], true);
  if (state.status !== 'paused') {
    return refuse('quizshow_command_not_allowed', state, true);
  }
  const { cursor } = state;
  const replayQuestion =
    cursor.isRestartRecovery &&
    QUESTION_PHASES.includes(cursor.phase) &&
    cursor.roundIndex !== null &&
    cursor.questionIndex !== null
      ? snapshotQuestionAt(
          state.snapshot,
          cursor.roundIndex,
          cursor.questionIndex,
        )
      : null;
  if (
    replayQuestion !== null &&
    cursor.roundIndex !== null &&
    cursor.questionIndex !== null
  ) {
    const effects: QuizshowEngineEffect[] = [
      persist({ type: 'delete_question_plays', questionId: replayQuestion.id }),
    ];
    state.questionLog = state.questionLog.filter(
      (entry) => entry.questionId !== replayQuestion.id,
    );
    state.current = null;
    state.pausedAt = null;
    state.status = 'running';
    effects.push(
      ...openQuestion(state, cursor.roundIndex, cursor.questionIndex, now),
    );
    return hostActed(state, now, effects, false);
  }
  const pausedAt = state.pausedAt ?? now;
  if (cursor.phaseStartedAt !== null) cursor.phaseStartedAt += now - pausedAt;
  if (cursor.pausedRemainingMs !== null) {
    cursor.deadline = now + cursor.pausedRemainingMs;
    cursor.extraTimeDeadline =
      cursor.pausedExtraTimeRemainingMs === null
        ? null
        : now + cursor.pausedExtraTimeRemainingMs;
  }
  cursor.pausedRemainingMs = null;
  cursor.pausedExtraTimeRemainingMs = null;
  cursor.isRestartRecovery = false;
  state.pausedAt = null;
  setSessionStatus(state, 'running');
  return hostActed(
    state,
    now,
    [{ kind: 'phase_changed' }, ...phaseTimer(state)],
    false,
  );
}

export function hostAddTime(
  state: QuizshowLiveState,
  input: { phaseId: string; seconds: number; expectedDeadline: number },
  now: number,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  const { cursor } = state;
  if (input.phaseId !== cursor.phaseId) {
    return refuse('quizshow_stale_phase', state, true);
  }
  if (state.status !== 'running' || !isTimedPhase(cursor.phase)) {
    return refuse('quizshow_command_not_allowed', state, true);
  }
  if (cursor.deadline === null || input.expectedDeadline !== cursor.deadline) {
    return hostActed(state, now, [], true);
  }
  const addedMs = input.seconds * 1000;
  cursor.deadline += addedMs;
  if (cursor.extraTimeDeadline !== null) cursor.extraTimeDeadline += addedMs;
  return hostActed(
    state,
    now,
    [{ kind: 'phase_changed' }, ...phaseTimer(state)],
    false,
  );
}

export function hostReveal(
  state: QuizshowLiveState,
  phaseId: string,
  now: number,
  random: QuizshowRandom = CRYPTO_RANDOM,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  const movingCheck = checkMovingCommand(state, phaseId);
  if (movingCheck === 'stale')
    return refuse('quizshow_stale_phase', state, true);
  if (movingCheck === 'noop') return hostActed(state, now, [], true);
  const { phase } = state.cursor;
  if (state.status !== 'running' || (phase !== 'open' && phase !== 'vote')) {
    return refuse('quizshow_command_not_allowed', state, true);
  }
  return hostActed(
    state,
    now,
    closeTimedPhase(state, now, false, random),
    false,
  );
}

export function hostSkip(
  state: QuizshowLiveState,
  phaseId: string,
  now: number,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  const movingCheck = checkMovingCommand(state, phaseId);
  if (movingCheck === 'stale')
    return refuse('quizshow_stale_phase', state, true);
  if (movingCheck === 'noop') return hostActed(state, now, [], true);
  if (state.status !== 'running') {
    return refuse('quizshow_command_not_allowed', state, true);
  }
  const { phase } = state.cursor;
  const play = state.current;
  if (QUESTION_PHASES.includes(phase) && play !== null) {
    play.wasSkipped = true;
    const logEntry = findLogEntry(state, play.questionId);
    if (logEntry !== undefined) logEntry.wasSkipped = true;
    return hostActed(state, now, afterQuestion(state, now), false);
  }
  if (phase === 'reveal' && isQuizRoundInPlay(state)) {
    return hostActed(state, now, afterQuestion(state, now), false);
  }
  return refuse('quizshow_command_not_allowed', state, true);
}

export function hostShowAnswers(
  state: QuizshowLiveState,
  phaseId: string,
  now: number,
  random: QuizshowRandom = CRYPTO_RANDOM,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  const movingCheck = checkMovingCommand(state, phaseId);
  if (movingCheck === 'stale')
    return refuse('quizshow_stale_phase', state, true);
  if (movingCheck === 'noop') return hostActed(state, now, [], true);
  if (state.status !== 'running' || state.cursor.phase !== 'review') {
    return refuse('quizshow_command_not_allowed', state, true);
  }
  return hostActed(state, now, startVote(state, now, random), false);
}

export function hostHideAnswer(
  state: QuizshowLiveState,
  input: { answerId: string; isHidden: boolean },
  actorUserId: string,
  now: number,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  if (!isOpenStatus(state.status)) {
    return refuse('quizshow_command_not_allowed', state, true);
  }
  const play = state.current;
  const answer = play === null ? undefined : findAnswer(play, input.answerId);
  if (
    play === null ||
    answer === undefined ||
    !isPromptQuestionInPlay(state, play)
  ) {
    return refuse('quizshow_answer_not_found', state, false);
  }
  const isAuthorRemoved =
    (state.players.get(answer.playerId)?.removedAt ?? null) !== null;
  if (!input.isHidden && (state.cursor.phase !== 'review' || isAuthorRemoved)) {
    return refuse('quizshow_command_not_allowed', state, true);
  }
  if ((answer.hiddenAt !== null) === input.isHidden) {
    return hostActed(state, now, [], true);
  }
  const effects: QuizshowEngineEffect[] = [];
  if (input.isHidden) {
    effects.push(...hideAnswerInPlay(state, play, answer, now));
    effects.push(...refreshPodiumIfShown(state));
  } else {
    answer.hiddenAt = null;
    effects.push({ kind: 'review_list_changed' });
  }
  effects.push(
    persist({
      type: 'set_answer_hidden',
      answerId: answer.answerId,
      hiddenAt: answer.hiddenAt,
      hiddenByUserId: input.isHidden ? actorUserId : null,
    }),
  );
  return hostActed(state, now, effects, false);
}

export function hostPickFavourite(
  state: QuizshowLiveState,
  input: { phaseId: string; questionId: string; optionId: string },
  now: number,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  if (input.phaseId !== state.cursor.phaseId) {
    return refuse('quizshow_stale_phase', state, true);
  }
  const play = state.current;
  const round =
    play === null ? undefined : state.snapshot.rounds[play.roundIndex];
  if (
    state.status !== 'running' ||
    state.cursor.phase !== 'reveal' ||
    play === null ||
    round === undefined ||
    (round.kind !== 'caption_this' && round.kind !== 'drag_name')
  ) {
    return refuse('quizshow_command_not_allowed', state, true);
  }
  if (input.questionId !== play.questionId) {
    return refuse('quizshow_wrong_question', state, false);
  }
  if (play.favouriteOptionId !== null) return hostActed(state, now, [], true);
  const option = play.voteOptions?.find(
    (voteOption) => voteOption.optionId === input.optionId,
  );
  const optionAnswerId = option?.answerId ?? null;
  const answer =
    optionAnswerId === null ? undefined : findAnswer(play, optionAnswerId);
  if (
    option === undefined ||
    option.isTruth ||
    answer === undefined ||
    answer.hiddenAt !== null
  ) {
    return refuse('quizshow_vote_option_not_found', state, false);
  }
  play.favouriteOptionId = option.optionId;
  const bonus =
    scorePartyVotes({
      votes: [],
      favouriteAuthorPlayerId: answer.playerId,
      isJokerActiveFor: (playerId) =>
        isJokerActiveFor(state, playerId, play.roundIndex),
    }).get(answer.playerId) ?? 0;
  answer.pointsAwarded += bonus;
  const author = state.players.get(answer.playerId);
  if (author !== undefined) author.score += bonus;
  play.pointsByPlayer.set(
    answer.playerId,
    (play.pointsByPlayer.get(answer.playerId) ?? 0) + bonus,
  );
  applyTeamPoints(state, play);
  return hostActed(
    state,
    now,
    [
      { kind: 'reveal_updated', favouriteAuthorPlayerId: answer.playerId },
      persist(saveScoringOperation(state, play)),
    ],
    false,
  );
}

export function hostRemovePlayer(
  state: QuizshowLiveState,
  playerId: string,
  actorUserId: string,
  now: number,
  random: QuizshowRandom = CRYPTO_RANDOM,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  const player = state.players.get(playerId);
  if (player === undefined) {
    return refuse('quizshow_player_not_found', state, false);
  }
  if (!isOpenStatus(state.status)) {
    return refuse('quizshow_command_not_allowed', state, true);
  }
  if (player.removedAt !== null) return hostActed(state, now, [], true);
  player.removedAt = now;
  const effects: QuizshowEngineEffect[] = [];
  const play = state.current;
  const answer = play?.answers.get(playerId);
  if (
    play !== null &&
    answer !== undefined &&
    answer.hiddenAt === null &&
    isPromptQuestionInPlay(state, play)
  ) {
    effects.push(...hideAnswerInPlay(state, play, answer, now));
  }
  effects.push(
    persist({ type: 'update_player', playerId, fields: { removedAt: now } }),
    persist({
      type: 'hide_player_answers',
      playerId,
      hiddenAt: now,
      hiddenByUserId: actorUserId,
    }),
    { kind: 'player_removed', playerId },
    { kind: 'lobby_changed' },
    ...refreshPodiumIfShown(state),
    ...closeIfEveryoneDone(state, now, random),
  );
  return hostActed(state, now, effects, false);
}

export function hostRenameTeam(
  state: QuizshowLiveState,
  input: { teamId: string; name: string },
  now: number,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  const team = state.teams.get(input.teamId);
  if (team === undefined)
    return refuse('quizshow_team_not_found', state, false);
  if (!isOpenStatus(state.status)) {
    return refuse('quizshow_command_not_allowed', state, true);
  }
  const name = input.name.trim();
  if (name === '') return refuse('quizshow_text_blank', state, false);
  if (textHasBlockedTerm(name)) {
    return refuse('quizshow_text_blocked', state, false);
  }
  const nameKey = name.toLowerCase();
  const isNameTaken = [...state.teams.values()].some(
    (otherTeam) =>
      otherTeam.teamId !== team.teamId &&
      otherTeam.name.trim().toLowerCase() === nameKey,
  );
  if (isNameTaken) return refuse('quizshow_team_name_taken', state, false);
  if (name === team.name) return hostActed(state, now, [], true);
  team.name = name;
  const memberIds = activePlayers(state)
    .filter((player) => player.teamId === team.teamId)
    .map((player) => player.playerId);
  return hostActed(
    state,
    now,
    [
      { kind: 'lobby_changed' },
      { kind: 'me_changed', playerIds: memberIds },
      persist({ type: 'update_team', teamId: team.teamId, fields: { name } }),
    ],
    false,
  );
}

export function hostEnd(
  state: QuizshowLiveState,
  phaseId: string,
  now: number,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  const movingCheck = checkMovingCommand(state, phaseId);
  if (movingCheck === 'stale')
    return refuse('quizshow_stale_phase', state, true);
  if (movingCheck === 'noop') return hostActed(state, now, [], true);
  if (!isOpenStatus(state.status)) {
    return refuse('quizshow_command_not_allowed', state, true);
  }
  if (state.cursor.phase === 'podium') {
    return hostActed(state, now, finishSession(state, now), false);
  }
  if (state.status === 'lobby' || !state.hasScoredQuestion) {
    return hostActed(state, now, abandonSession(state, now), false);
  }
  return hostActed(state, now, showPodium(state, now), false);
}

/** Any status but `finished` and `abandoned`; the gateway emits `screen:muted` on a change. */
export function hostSetScreenMuted(
  state: QuizshowLiveState,
  isMuted: boolean,
  now: number,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  if (!isOpenStatus(state.status)) {
    return refuse('quizshow_command_not_allowed', state, true);
  }
  if (state.isScreenMuted === isMuted) return hostActed(state, now, [], true);
  state.isScreenMuted = isMuted;
  return hostActed(state, now, [], false);
}

/** A phase timer fired; stale phase ids and a paused session do nothing. */
export function timerElapsed(
  state: QuizshowLiveState,
  phaseId: string,
  now: number,
  random: QuizshowRandom = CRYPTO_RANDOM,
): QuizshowEngineEffect[] {
  const { cursor } = state;
  if (phaseId !== cursor.phaseId || state.status !== 'running') return [];
  if (cursor.phase === 'read') {
    if (cursor.deadline !== null && now < cursor.deadline) {
      return phaseTimer(state);
    }
    return openAnswers(state, now);
  }
  if (SUBMISSION_PHASES.includes(cursor.phase)) {
    if (
      cursor.deadline !== null &&
      now < cursor.deadline + QUIZSHOW_LIMITS.answerGraceMs
    ) {
      return phaseTimer(state);
    }
    return withSingleCheckpoint(closeTimedPhase(state, now, true, random));
  }
  return [];
}

/** The runtime calls this after every accepted answer, vote and removal. */
export function closeIfEveryoneDone(
  state: QuizshowLiveState,
  now: number,
  random: QuizshowRandom = CRYPTO_RANDOM,
): QuizshowEngineEffect[] {
  const play = state.current;
  if (
    state.status !== 'running' ||
    play === null ||
    !SUBMISSION_PHASES.includes(state.cursor.phase)
  ) {
    return [];
  }
  const isSomeoneStillToSubmit = [...play.eligiblePlayerIds].some((playerId) =>
    isAwaitedSubmitter(state, playerId, now),
  );
  if (isSomeoneStillToSubmit) return [];
  return withSingleCheckpoint(closeTimedPhase(state, now, false, random));
}

/** A lobby, running or paused session with no host command for `abandonAfterMs` ends with no results. */
export function abandonIfIdle(
  state: QuizshowLiveState,
  now: number,
): QuizshowEngineEffect[] {
  if (!isOpenStatus(state.status)) return [];
  if (now - state.lastHostCommandAt < QUIZSHOW_LIMITS.abandonAfterMs) return [];
  return abandonSession(state, now);
}

/** The event was cancelled or deleted: any open session ends with no results. */
export function abandonNow(
  state: QuizshowLiveState,
  now: number,
): QuizshowEngineEffect[] {
  if (!isOpenStatus(state.status)) return [];
  return abandonSession(state, now);
}
