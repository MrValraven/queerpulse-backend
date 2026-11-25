/**
 * Pulse Live (`quizshow`) engine, host rescoring: accepting a typed answer,
 * changing the correct option of a choice question and adjusting an
 * entrant's points by hand (contract 4.3, 6.4). Pure: every time comes in as
 * a `now` argument. The two corrections rescore the whole question from the
 * streaks recorded at its first scoring, so a second correction starts from
 * the same ground as the first.
 */
import type { QuizshowAnswerKeyView } from './quizshow.contract';
import { normaliseAnswerText } from './quizshow-answer-normaliser';
import {
  applyTeamPoints,
  checkpoint,
  currentPlayContext,
  hostActed,
  noteHostCommand,
  saveScoringOperation,
  scoreQuizQuestion,
  scoresScopeShownIn,
  totalsByEntrant,
  type QuizshowHostOutcome,
  type QuizshowPlayContext,
} from './quizshow-engine-phases';
import {
  eligiblePlayersNow,
  isActivePlayer,
  persist,
  refuse,
} from './quizshow-engine-state';
import type {
  QuizshowEngineEffect,
  QuizshowLivePlayer,
  QuizshowLiveQuestionPlay,
  QuizshowLiveState,
  QuizshowPersistOperation,
} from './quizshow-engine-types';
import { effectiveAnswerKey } from './quizshow-snapshot';
import { isQuizRoundKind } from './quizshow-wheel';

/** How many host:adjustPoints request ids the session remembers for its no-op rule (contract 6.4). */
const ADJUST_REQUEST_IDS_KEPT = 50;

export type QuizshowChoiceAnswerChange =
  | { type: 'multiple_choice'; correctIndexes: number[] }
  | { type: 'true_false'; isTrue: boolean };

/**
 * Who a correction judges again: exactly the players the first scoring judged
 * (the keys of `streakBeforeByPlayer`) whose row a host did not remove. A
 * player who left after the reveal is included; one who left before it was
 * never judged and stays out; a host-removed player keeps what they had.
 */
function rescoredPlayersOf(
  state: QuizshowLiveState,
  play: QuizshowLiveQuestionPlay,
): Array<{ player: QuizshowLivePlayer; streakBefore: number }> {
  return [...play.streakBeforeByPlayer].flatMap(([playerId, streakBefore]) => {
    const player = state.players.get(playerId);
    return player === undefined || player.removedAt !== null
      ? []
      : [{ player, streakBefore }];
  });
}

/**
 * A rescore names the cursor's phase id, or in `scores` the id of the reveal
 * it came from (contract 13): `typed:answers` carries the reveal's id, and
 * `scores` is entered from that question's reveal alone, so the transition
 * into the current `scores` phase names it.
 */
function isRescorePhaseId(state: QuizshowLiveState, phaseId: string): boolean {
  if (phaseId === state.cursor.phaseId) return true;
  const lastTransition = state.lastTransition;
  return (
    state.cursor.phase === 'scores' &&
    lastTransition !== null &&
    lastTransition.toPhaseId === state.cursor.phaseId &&
    lastTransition.fromPhaseId === phaseId
  );
}

/**
 * The gate both corrections share (contract 6.4 rule 1). A play with no
 * recorded streaks was scored before a restart, so its streaks cannot be
 * rebuilt and the question stays as it was scored.
 */
function rescoreRefusal(
  state: QuizshowLiveState,
  phaseId: string,
  questionId: string,
): QuizshowHostOutcome | null {
  if (!isRescorePhaseId(state, phaseId)) {
    return refuse('quizshow_stale_phase', state, true);
  }
  const play = state.current;
  const round =
    play === null ? undefined : state.snapshot.rounds[play.roundIndex];
  const isRescoreStatus =
    state.status === 'running' || state.status === 'paused';
  const isRescorePhase =
    state.cursor.phase === 'reveal' || state.cursor.phase === 'scores';
  if (
    !isRescoreStatus ||
    !isRescorePhase ||
    play === null ||
    round === undefined ||
    !isQuizRoundKind(round.kind) ||
    play.streakBeforeByPlayer.size === 0
  ) {
    return refuse('quizshow_rescore_not_now', state, true);
  }
  if (play.questionId !== questionId) {
    return refuse('quizshow_wrong_question', state, false);
  }
  return null;
}

/** host:acceptAnswer: one normalised typed text now counts as correct (contract 6.4 rule 2). */
export function hostAcceptAnswer(
  state: QuizshowLiveState,
  input: { phaseId: string; questionId: string; normalisedText: string },
  now: number,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  const refusal = rescoreRefusal(state, input.phaseId, input.questionId);
  if (refusal !== null) return refusal;
  const context = currentPlayContext(state);
  const { play, question } = context;
  if (question.type !== 'type_answer') {
    return refuse('quizshow_accept_needs_typed_answer', state, false);
  }
  // A repeated accept of a text already accepted (a retry or a second host tap) acks as a no-op.
  if (play.acceptedTexts.has(input.normalisedText)) {
    return hostActed(state, now, [], true);
  }
  const matchingAnswers = rescoredPlayersOf(state, play).flatMap(
    ({ player }) => {
      const answer = play.answers.get(player.playerId);
      return answer !== undefined &&
        answer.payload.type === 'type_answer' &&
        normaliseAnswerText(answer.payload.text) === input.normalisedText
        ? [answer]
        : [];
    },
  );
  if (matchingAnswers.length === 0) {
    return refuse('quizshow_answer_text_not_found', state, false);
  }
  if (matchingAnswers.every((answer) => answer.isCorrect === true)) {
    return refuse('quizshow_answer_already_correct', state, false);
  }
  play.acceptedTexts.add(input.normalisedText);
  return hostActed(state, now, rescoreQuestion(state, context, true), false);
}

/** host:changeCorrectAnswer: a new key for a multiple choice or true or false question (contract 6.4 rule 3). */
export function hostChangeCorrectAnswer(
  state: QuizshowLiveState,
  input: {
    phaseId: string;
    questionId: string;
    answer: QuizshowChoiceAnswerChange;
  },
  now: number,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  const refusal = rescoreRefusal(state, input.phaseId, input.questionId);
  if (refusal !== null) return refusal;
  const context = currentPlayContext(state);
  const { play, round, question } = context;
  if (
    (question.type !== 'multiple_choice' && question.type !== 'true_false') ||
    input.answer.type !== question.type
  ) {
    return refuse('quizshow_change_needs_choice_question', state, false);
  }
  const currentKey = effectiveAnswerKey(round, question, play.keyOverride);
  let nextKey: QuizshowAnswerKeyView;
  if (input.answer.type === 'multiple_choice') {
    const optionCount = (question.shownOptions ?? question.options).length;
    const isEveryIndexShown = input.answer.correctIndexes.every(
      (optionIndex) =>
        Number.isInteger(optionIndex) &&
        optionIndex >= 0 &&
        optionIndex < optionCount,
    );
    if (!isEveryIndexShown) {
      return refuse('quizshow_correct_option_not_found', state, false);
    }
    // A fresh array: the snapshot's key is frozen and shared, so the override never aliases it.
    const correctIndexes = [...new Set(input.answer.correctIndexes)].sort(
      (first, second) => first - second,
    );
    if (correctIndexes.length >= optionCount) {
      return refuse('quizshow_every_option_correct', state, false);
    }
    const currentIndexes =
      currentKey?.type === 'multiple_choice'
        ? [...currentKey.correctIndexes].sort((first, second) => first - second)
        : null;
    const isSameKey =
      currentIndexes !== null &&
      currentIndexes.length === correctIndexes.length &&
      currentIndexes.every(
        (optionIndex, position) => optionIndex === correctIndexes[position],
      );
    if (isSameKey) return hostActed(state, now, [], true);
    nextKey = { type: 'multiple_choice', correctIndexes };
  } else {
    const isTrue = input.answer.isTrue;
    if (currentKey?.type === 'true_false' && currentKey.isTrue === isTrue) {
      return hostActed(state, now, [], true);
    }
    nextKey = { type: 'true_false', isTrue };
  }
  play.keyOverride = nextKey;
  return hostActed(state, now, rescoreQuestion(state, context, false), false);
}

/**
 * The save_scoring write of a rescore: every answer of the question, every
 * team, and exactly the players the rescore judged again.
 */
function rescoreSavingOperation(
  state: QuizshowLiveState,
  context: QuizshowPlayContext,
  rescoredPlayers: readonly QuizshowLivePlayer[],
): QuizshowPersistOperation {
  const operation = saveScoringOperation(state, context.play);
  if (operation.type !== 'save_scoring') return operation;
  return {
    ...operation,
    players: rescoredPlayers.map((player) => ({
      playerId: player.playerId,
      score: player.score,
      streak: player.streak,
    })),
  };
}

/**
 * Takes back what the question paid each rescored player, gives them the
 * streak they had before it, then scores it again against the effective key
 * and the accepted texts (contract 6.4 rules 4 to 6). Team totals move by the
 * difference only, so a host adjustment made earlier stays. A host-removed
 * player keeps their points in `pointsByPlayer`, so their team share stays
 * too.
 */
export function rescoreQuestion(
  state: QuizshowLiveState,
  context: QuizshowPlayContext,
  shouldEmitTypedAnswers: boolean,
): QuizshowEngineEffect[] {
  const { play } = context;
  const rescoredEntries = rescoredPlayersOf(state, play);
  const rescoredPlayers = rescoredEntries.map(({ player }) => player);
  for (const { player, streakBefore } of rescoredEntries) {
    player.score -= play.pointsByPlayer.get(player.playerId) ?? 0;
    player.streak = streakBefore;
    play.pointsByPlayer.delete(player.playerId);
  }
  // A player who left after the reveal is judged like anyone who played the question.
  scoreQuizQuestion(state, context, rescoredPlayers);
  applyTeamPoints(state, play);
  // A host may have lowered a total since the first scoring, so taking the old points back can pass 0: every score stops at 0.
  for (const player of rescoredPlayers) {
    player.score = Math.max(0, player.score);
  }
  for (const team of state.teams.values()) {
    team.score = Math.max(0, team.score);
  }
  play.wasCorrected = true;
  state.correctedQuestionIds.add(play.questionId);
  const isScoresShown = state.cursor.phase === 'scores';
  if (isScoresShown) {
    // `lastScoresFrame` stays, so the count-up still starts from the totals before the question.
    state.scoresAtLastFrame = totalsByEntrant(state);
  }
  const effects: QuizshowEngineEffect[] = [
    persist(rescoreSavingOperation(state, context, rescoredPlayers)),
    persist({
      type: 'set_answer_key_override',
      questionId: play.questionId,
      keyOverride: play.keyOverride,
      acceptedTexts: [...play.acceptedTexts],
    }),
    { kind: 'reveal_updated', scope: 'everyone' },
  ];
  if (shouldEmitTypedAnswers) effects.push({ kind: 'typed_answers_changed' });
  if (isScoresShown) effects.push({ kind: 'scores_shown', scope: 'question' });
  effects.push(
    { kind: 'lobby_changed' },
    {
      kind: 'me_changed',
      playerIds: eligiblePlayersNow(state).map((player) => player.playerId),
    },
    checkpoint(),
  );
  return effects;
}

/**
 * host:adjustPoints: moves a player's (solo) or a team's (teams) total by
 * hand (contract 6.4). The question points in `pointsByPlayer` stay as they
 * are, so a later rescore keeps the adjustment.
 */
export function hostAdjustPoints(
  state: QuizshowLiveState,
  input: { entrantId: string; delta: number; requestId: string },
  now: number,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  // A retry of an applied request stays a no-op after the phase moved on.
  if (state.adjustRequestIds.includes(input.requestId)) {
    return hostActed(state, now, [], true);
  }
  const isAdjustStatus =
    state.status === 'running' || state.status === 'paused';
  if (!isAdjustStatus || state.cursor.phase === 'podium') {
    return refuse('quizshow_adjust_not_now', state, true);
  }
  let entrant: { score: number } | null = null;
  let changedPlayerIds: string[] = [];
  if (state.playMode === 'solo') {
    const player = state.players.get(input.entrantId);
    if (player !== undefined && isActivePlayer(player)) {
      entrant = player;
      changedPlayerIds = [player.playerId];
    }
  } else {
    const team = state.teams.get(input.entrantId);
    if (team !== undefined) {
      entrant = team;
      changedPlayerIds = [...state.players.values()]
        .filter(
          (player) => player.teamId === team.teamId && isActivePlayer(player),
        )
        .map((player) => player.playerId);
    }
  }
  if (entrant === null) {
    return refuse('quizshow_entrant_not_found', state, false);
  }
  if (entrant.score + input.delta < 0) {
    return refuse('quizshow_adjust_below_zero', state, false);
  }
  entrant.score += input.delta;
  state.adjustRequestIds.push(input.requestId);
  if (state.adjustRequestIds.length > ADJUST_REQUEST_IDS_KEPT) {
    state.adjustRequestIds.splice(
      0,
      state.adjustRequestIds.length - ADJUST_REQUEST_IDS_KEPT,
    );
  }
  const effects: QuizshowEngineEffect[] = [
    persist({
      type: 'adjust_score',
      kind: state.playMode === 'solo' ? 'player' : 'team',
      entrantId: input.entrantId,
      score: entrant.score,
    }),
  ];
  const shownScoresScope = scoresScopeShownIn(state.cursor.phase);
  if (shownScoresScope !== null) {
    // The scores on show counted the old total: send them again, still counting up from the same previous frame.
    state.scoresAtLastFrame = totalsByEntrant(state);
    effects.push({ kind: 'scores_shown', scope: shownScoresScope });
  }
  effects.push({ kind: 'lobby_changed' });
  if (changedPlayerIds.length > 0) {
    effects.push({ kind: 'me_changed', playerIds: changedPlayerIds });
  }
  return hostActed(state, now, effects, false);
}
