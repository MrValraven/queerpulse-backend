/**
 * Emitted by `ContentOwnerErasureService` before a member's account goes. The
 * owner's games cascade with the account, so their open sessions end first
 * and players see the game end. Dependency free so the account module can
 * import it without pulling in the Pulse Live module.
 */
export const QUIZSHOW_OWNER_ERASING = 'quizshow.owner_erasing';

export interface QuizshowOwnerErasingEvent {
  userId: string;
}
