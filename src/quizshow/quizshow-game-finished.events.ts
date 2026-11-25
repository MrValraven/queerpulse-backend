/**
 * Emitted after the finish commit of a numbered event game (contract 5.2).
 * Dependency free so `src/quiz-win-badges/` can import it without a module edge.
 */
export const QUIZ_EVENT_GAME_FINISHED = 'quizshow.event_game_finished';

/** One member who won an event game, as resolved from the podium at finish time. */
export interface QuizEventGameWinnerCandidate {
  userId: string;
  screenName: string;
  /** The winning team's name; null for a solo win. */
  teamName: string | null;
}

/** Payload of `QUIZ_EVENT_GAME_FINISHED`. */
export interface QuizEventGameFinishedEvent {
  sessionId: string;
  eventId: string;
  gameNumber: number;
  finishedAt: Date;
  eventTitle: string;
  isAdultsOnly: boolean;
  winners: QuizEventGameWinnerCandidate[];
}
