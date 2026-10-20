import { isEarlyAccessFeature, isFeatureLaunched } from '../launchedFeatures';
import type { QuizshowContentLabel } from './quizshow.contract';

/**
 * Whether anyone may play Pulse Live right now. Playing is open to every
 * active member while the feature is launched or in early access; early
 * access grants gate hosting only and are never read for playing.
 */
export function isQuizshowPlayable(): boolean {
  return isFeatureLaunched('quizshow') || isEarlyAccessFeature('quizshow');
}

/**
 * The 18+ flag of a session: the scope's own flag (the event's adults only
 * format detail, or the game's switch), or true when the frozen session
 * snapshot holds an adults round. A game whose switch went off after its
 * lobby opened stays 18+ for the rounds it already froze.
 */
export function isAdultsOnlySession(
  isScopeAdultsOnly: boolean,
  snapshot: {
    rounds: ReadonlyArray<{ contentLabel: QuizshowContentLabel }>;
  },
): boolean {
  return (
    isScopeAdultsOnly ||
    snapshot.rounds.some((round) => round.contentLabel === 'adults')
  );
}
