import type { QuizEventGameWinnerCandidate } from './quizshow-game-finished.events';
import { isActivePlayer } from './quizshow-engine-state';
import type { QuizshowLiveState } from './quizshow-engine-types';
import type { QuizshowStoredPodiumEntry } from './entities/quizshow-result.entity';

/**
 * True when a finished session takes the next event game number (contract 5.1):
 * an event session that is a real game and has some entrant in first place.
 */
export function shouldNumberEventGame(
  state: Pick<QuizshowLiveState, 'kind' | 'isPractice'>,
  podium: readonly QuizshowStoredPodiumEntry[],
): boolean {
  return (
    state.kind === 'event' &&
    !state.isPractice &&
    podium.some((entry) => entry.place === 1)
  );
}

/**
 * Members who won the game (contract 5.2): every first place entry, a solo
 * entry yields its player and a team entry yields its active members. Co-host
 * players never win. Deduplicated by user id, in podium order then joined order.
 */
export function eventGameWinnersOf(
  state: Pick<QuizshowLiveState, 'players' | 'teams'>,
  podium: readonly QuizshowStoredPodiumEntry[],
): QuizEventGameWinnerCandidate[] {
  const winnersByUserId = new Map<string, QuizEventGameWinnerCandidate>();
  const addWinner = (candidate: QuizEventGameWinnerCandidate): void => {
    if (!winnersByUserId.has(candidate.userId)) {
      winnersByUserId.set(candidate.userId, candidate);
    }
  };

  for (const entry of podium) {
    if (entry.place !== 1) continue;

    if (entry.kind === 'player') {
      const player = state.players.get(entry.entrantId);
      if (!player || player.isCohostPlayer) continue;
      addWinner({
        userId: player.userId,
        screenName: player.screenName,
        teamName: null,
      });
      continue;
    }

    const teamName = state.teams.get(entry.entrantId)?.name ?? null;
    const members = [...state.players.values()]
      .filter(
        (player) =>
          player.teamId === entry.entrantId &&
          isActivePlayer(player) &&
          !player.isCohostPlayer,
      )
      .sort((first, second) => first.joinedAt - second.joinedAt);
    for (const member of members) {
      addWinner({
        userId: member.userId,
        screenName: member.screenName,
        teamName,
      });
    }
  }

  return [...winnersByUserId.values()];
}
