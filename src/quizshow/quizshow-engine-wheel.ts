/**
 * Pulse Live (`quizshow`) wheel bonus: the flat award a slice pays its best
 * scorer. Pure engine function; the caller applies the returned effects.
 */
import type { QuizshowWheelBonusView } from './quizshow.contract';
import { entrantTotals, persist } from './quizshow-engine-state';
import type {
  QuizshowEngineEffect,
  QuizshowLiveState,
} from './quizshow-engine-types';
import { pointsSinceBaseline, wheelBonusWinnerIds } from './quizshow-scoring';
import { withWheelSettingsDefaults } from './quizshow-wheel';

export interface QuizshowWheelBonusResult {
  view: QuizshowWheelBonusView;
  /** Persist `save_wheel_bonus`, `lobby_changed`, and `me_changed` for awarded solo players. */
  effects: QuizshowEngineEffect[];
}

/**
 * Gives the slice's bonus to every entrant tied for the most points on it and
 * returns the view plus the effects. Null when the slice carries no bonus, no
 * wheel is open or nobody scored above 0. Pick a round counts the points that
 * reached totals since the round opened; pick a question counts the points the
 * current question earned. Removed players are never entrants, and an award
 * stands once made.
 */
export function applyWheelBonus(
  state: QuizshowLiveState,
  sliceRoundIndex: number,
): QuizshowWheelBonusResult | null {
  const wheel = state.wheelProgress.wheel;
  if (wheel === null) return null;
  const sliceRow = state.snapshot.rounds[sliceRoundIndex];
  if (sliceRow === undefined) return null;
  const bonus = withWheelSettingsDefaults(sliceRow.settings).wheelBonus;
  if (bonus === 0) return null;

  const totals = entrantTotals(state);
  const isSolo = state.playMode === 'solo';
  const pointsByEntrant =
    wheel.pick === 'round'
      ? pointsSinceBaseline(wheel.baselineByEntrant ?? {}, totals)
      : totals.map((total) => ({
          entrantId: total.entrantId,
          points:
            (isSolo
              ? state.current?.pointsByPlayer.get(total.entrantId)
              : state.current?.teamPoints.get(total.entrantId)) ?? 0,
        }));

  const winnerIds = new Set(wheelBonusWinnerIds(pointsByEntrant));
  if (winnerIds.size === 0) return null;
  const winners = totals.filter((total) => winnerIds.has(total.entrantId));

  // Winners come from the same totals as the entrants, so each one resolves
  // below; the view lists only the entrants that were credited.
  const creditedWinners: typeof winners = [];
  const awardedPlayers: Array<{ playerId: string; score: number }> = [];
  const awardedTeams: Array<{ teamId: string; score: number }> = [];
  for (const winner of winners) {
    if (isSolo) {
      const player = state.players.get(winner.entrantId);
      if (player === undefined) continue;
      player.score += bonus;
      awardedPlayers.push({ playerId: player.playerId, score: player.score });
      creditedWinners.push(winner);
    } else {
      const team = state.teams.get(winner.entrantId);
      if (team === undefined) continue;
      team.score += bonus;
      awardedTeams.push({ teamId: team.teamId, score: team.score });
      creditedWinners.push(winner);
    }
  }

  const effects: QuizshowEngineEffect[] = [
    persist({
      type: 'save_wheel_bonus',
      players: awardedPlayers,
      teams: awardedTeams,
    }),
    { kind: 'lobby_changed' },
  ];
  if (isSolo) {
    effects.push({
      kind: 'me_changed',
      playerIds: awardedPlayers.map((awarded) => awarded.playerId),
    });
  }

  return {
    view: {
      points: bonus,
      pick: wheel.pick,
      sliceRoundIndex,
      sliceTitle: { ...sliceRow.title },
      winners: creditedWinners.map((winner) => ({
        entrantId: winner.entrantId,
        kind: winner.kind,
        name: winner.name,
        colorKey: winner.colorKey,
      })),
    },
    effects,
  };
}
