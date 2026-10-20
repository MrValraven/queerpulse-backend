/**
 * Pulse Live scoring. Pure functions with no clock and no randomness; the
 * frontend demo engine copies these formulas exactly.
 */
import {
  isTypedAnswerMatch,
  typedAnswerCandidates,
} from './quizshow-answer-normaliser';
import {
  QUIZSHOW_LIMITS,
  type QuizshowAnswerKeyView,
  type QuizshowAnswerPayload,
  type QuizshowQuestionType,
} from './quizshow.contract';

/**
 * Speed points: the full base at zero elapsed, falling linearly to half the
 * base at the player's own limit. Elapsed is clamped to `[0, limitMs]`.
 */
export function speedPoints(
  base: number,
  elapsedMs: number,
  limitMs: number,
  isSpeedBonusOn: boolean,
): number {
  if (!isSpeedBonusOn) return base;
  const clampedElapsedMs = Math.min(Math.max(elapsedMs, 0), limitMs);
  return Math.round(base * (1 - clampedElapsedMs / limitMs / 2));
}

/** The streak bonus for the streak length that includes this answer. */
export function streakBonusFor(streakAfterAnswer: number): number {
  return Math.min(
    streakAfterAnswer * QUIZSHOW_LIMITS.streakStep,
    QUIZSHOW_LIMITS.streakCap,
  );
}

export type ClosestOutcome = 'closest' | 'band' | 'none';

const distanceKey = (distance: number): number =>
  Number(distance.toPrecision(12));

/**
 * Every answer at the minimum distance from the truth is `closest`; any other
 * answer within the band (10% of the truth) is `band`; the rest are `none`.
 * A truth of 0 has a band of 0. Distances compare at 12 significant digits so
 * float noise keeps a decimal tie fair and an answer at the band edge inside.
 */
export function closestNumberOutcomes(
  truth: number,
  answers: ReadonlyArray<{ playerId: string; value: number }>,
): Map<string, ClosestOutcome> {
  const outcomes = new Map<string, ClosestOutcome>();
  if (answers.length === 0) return outcomes;
  const minimumDistance = Math.min(
    ...answers.map((answer) => Math.abs(answer.value - truth)),
  );
  const minimumDistanceKey = distanceKey(minimumDistance);
  const bandWidthKey = distanceKey(
    QUIZSHOW_LIMITS.closestNumberBand * Math.abs(truth),
  );
  for (const answer of answers) {
    const answerDistanceKey = distanceKey(Math.abs(answer.value - truth));
    if (answerDistanceKey === minimumDistanceKey) {
      outcomes.set(answer.playerId, 'closest');
    } else if (answerDistanceKey <= bandWidthKey) {
      outcomes.set(answer.playerId, 'band');
    } else {
      outcomes.set(answer.playerId, 'none');
    }
  }
  return outcomes;
}

export interface QuizAnswerScoringInput {
  type: Exclude<QuizshowQuestionType, 'prompt'>;
  base: number;
  answerKey: QuizshowAnswerKeyView;
  payload: QuizshowAnswerPayload | null;
  elapsedMs: number;
  ownLimitMs: number;
  isSpeedBonusOn: boolean;
  streakBefore: number;
  isJokerActive: boolean;
  closestOutcome: ClosestOutcome | null;
}

export interface QuizAnswerScore {
  isCorrect: boolean;
  correctPositions: number | null;
  streakAfter: number;
  streakBonus: number;
  pointsAwarded: number;
}

interface QuizAnswerJudgement {
  isCorrect: boolean;
  correctPositions: number | null;
  itemCount: number;
}

/** Whether a payload is right against its key. A payload of another type is wrong. */
function judgeQuizAnswer(
  answerKey: QuizshowAnswerKeyView,
  payload: QuizshowAnswerPayload,
  closestOutcome: ClosestOutcome | null,
): QuizAnswerJudgement {
  const wrongJudgement: QuizAnswerJudgement = {
    isCorrect: false,
    correctPositions: null,
    itemCount: 0,
  };
  switch (answerKey.type) {
    case 'multiple_choice':
      if (payload.type !== 'multiple_choice') return wrongJudgement;
      return {
        ...wrongJudgement,
        isCorrect: payload.optionIndex === answerKey.correctIndex,
      };
    case 'true_false':
      if (payload.type !== 'true_false') return wrongJudgement;
      return {
        ...wrongJudgement,
        isCorrect: payload.isTrue === answerKey.isTrue,
      };
    case 'type_answer':
      if (payload.type !== 'type_answer') return wrongJudgement;
      return {
        ...wrongJudgement,
        isCorrect: isTypedAnswerMatch(
          payload.text,
          typedAnswerCandidates(
            { text: answerKey.text },
            answerKey.acceptedAnswers,
          ),
        ),
      };
    case 'order': {
      const itemCount = answerKey.orderedIds.length;
      if (payload.type !== 'order') return { ...wrongJudgement, itemCount };
      const correctPositions = answerKey.orderedIds.filter(
        (optionId, position) => payload.orderedIds[position] === optionId,
      ).length;
      return {
        isCorrect: itemCount > 0 && correctPositions === itemCount,
        correctPositions,
        itemCount,
      };
    }
    case 'closest_number':
      if (payload.type !== 'closest_number') return wrongJudgement;
      return { ...wrongJudgement, isCorrect: closestOutcome === 'closest' };
    case 'lie_detector':
      return wrongJudgement;
  }
}

/**
 * Scores one quiz answer: speed points on a correct answer (closest number
 * takes the plain base), order partials and the closest-number band without
 * speed, the streak bonus on a correct answer, and the joker doubling the
 * whole question total.
 */
export function scoreQuizAnswer(
  input: QuizAnswerScoringInput,
): QuizAnswerScore {
  const {
    type,
    base,
    answerKey,
    payload,
    elapsedMs,
    ownLimitMs,
    isSpeedBonusOn,
    streakBefore,
    isJokerActive,
    closestOutcome,
  } = input;
  if (payload === null) {
    return {
      isCorrect: false,
      correctPositions: null,
      streakAfter: 0,
      streakBonus: 0,
      pointsAwarded: 0,
    };
  }
  const { isCorrect, correctPositions, itemCount } = judgeQuizAnswer(
    answerKey,
    payload,
    closestOutcome,
  );
  const raw = isCorrect
    ? type === 'closest_number'
      ? base
      : speedPoints(base, elapsedMs, ownLimitMs, isSpeedBonusOn)
    : type === 'order' && correctPositions !== null && correctPositions > 0
      ? Math.round((base * correctPositions) / itemCount)
      : type === 'closest_number' && closestOutcome === 'band'
        ? Math.round(base / 2)
        : 0;
  const streakAfter = isCorrect ? streakBefore + 1 : 0;
  const streakBonus = isCorrect ? streakBonusFor(streakAfter) : 0;
  const multiplier = isJokerActive ? QUIZSHOW_LIMITS.jokerMultiplier : 1;
  return {
    isCorrect,
    correctPositions,
    streakAfter,
    streakBonus,
    pointsAwarded: (raw + streakBonus) * multiplier,
  };
}

function addPoints(
  pointsByPlayer: Map<string, number>,
  playerId: string,
  points: number,
): void {
  pointsByPlayer.set(playerId, (pointsByPlayer.get(playerId) ?? 0) + points);
}

function applyJokers(
  pointsByPlayer: Map<string, number>,
  isJokerActiveFor: (playerId: string) => boolean,
): Map<string, number> {
  for (const [playerId, points] of pointsByPlayer) {
    if (isJokerActiveFor(playerId)) {
      pointsByPlayer.set(playerId, points * QUIZSHOW_LIMITS.jokerMultiplier);
    }
  }
  return pointsByPlayer;
}

/**
 * Lie Detector: a vote for the truth (author `null`) pays its voter, a vote
 * for a fake pays the fake's author. Players with nothing are absent.
 */
export function scoreLieDetectorVotes(input: {
  votes: ReadonlyArray<{
    voterPlayerId: string;
    authorPlayerId: string | null;
  }>;
  isJokerActiveFor: (playerId: string) => boolean;
}): Map<string, number> {
  const pointsByPlayer = new Map<string, number>();
  for (const vote of input.votes) {
    if (vote.authorPlayerId === null) {
      addPoints(
        pointsByPlayer,
        vote.voterPlayerId,
        QUIZSHOW_LIMITS.lieDetectorTruthPoints,
      );
    } else {
      addPoints(
        pointsByPlayer,
        vote.authorPlayerId,
        QUIZSHOW_LIMITS.lieDetectorFooledPoints,
      );
    }
  }
  return applyJokers(pointsByPlayer, input.isJokerActiveFor);
}

/**
 * Caption This and Drag Name Generator: points per vote received plus the
 * host's favourite bonus to its author. Players with nothing are absent.
 */
export function scorePartyVotes(input: {
  votes: ReadonlyArray<{ voterPlayerId: string; authorPlayerId: string }>;
  favouriteAuthorPlayerId: string | null;
  isJokerActiveFor: (playerId: string) => boolean;
}): Map<string, number> {
  const pointsByPlayer = new Map<string, number>();
  for (const vote of input.votes) {
    addPoints(
      pointsByPlayer,
      vote.authorPlayerId,
      QUIZSHOW_LIMITS.partyVotePoints,
    );
  }
  if (input.favouriteAuthorPlayerId !== null) {
    addPoints(
      pointsByPlayer,
      input.favouriteAuthorPlayerId,
      QUIZSHOW_LIMITS.hostFavouritePoints,
    );
  }
  return applyJokers(pointsByPlayer, input.isJokerActiveFor);
}

/**
 * Team points for one question: the rounded mean over the team's eligible
 * members, where a member with no points counts 0.
 */
export function teamQuestionPoints(
  eligibleMembers: ReadonlyArray<{ playerId: string; teamId: string }>,
  pointsByPlayer: ReadonlyMap<string, number>,
): Map<string, number> {
  const totalsByTeam = new Map<string, { sum: number; count: number }>();
  for (const member of eligibleMembers) {
    const total = totalsByTeam.get(member.teamId) ?? { sum: 0, count: 0 };
    total.sum += pointsByPlayer.get(member.playerId) ?? 0;
    total.count += 1;
    totalsByTeam.set(member.teamId, total);
  }
  const pointsByTeam = new Map<string, number>();
  for (const [teamId, total] of totalsByTeam) {
    pointsByTeam.set(teamId, Math.round(total.sum / total.count));
  }
  return pointsByTeam;
}

/**
 * Standard competition ranking: score descending, then name (base
 * sensitivity), then entrant id. Equal scores share a rank and the next rank
 * skips (1, 1, 3).
 */
export function competitionRanks<
  Entry extends { entrantId: string; score: number; name: string },
>(entries: readonly Entry[]): Array<Entry & { rank: number }> {
  const sortedEntries = [...entries].sort(
    (leftEntry, rightEntry) =>
      rightEntry.score - leftEntry.score ||
      leftEntry.name.localeCompare(rightEntry.name, 'en', {
        sensitivity: 'base',
      }) ||
      (leftEntry.entrantId < rightEntry.entrantId
        ? -1
        : leftEntry.entrantId > rightEntry.entrantId
          ? 1
          : 0),
  );
  const rankedEntries: Array<Entry & { rank: number }> = [];
  sortedEntries.forEach((entry, position) => {
    const previousEntry = rankedEntries[position - 1];
    const rank =
      previousEntry !== undefined && previousEntry.score === entry.score
        ? previousEntry.rank
        : position + 1;
    rankedEntries.push({ ...entry, rank });
  });
  return rankedEntries;
}
