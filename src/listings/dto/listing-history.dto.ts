import { ListingModerationEventDTO } from './listing-moderation-event.dto';
import { ListingQuestionDTO } from './listing-question.dto';

/** `GET /listings/admin/:ref/history` response (moderator/admin only) — the
 * listing's moderation events (item #16) and Q&A thread (item #17), both
 * newest-first. Feeds the admin drawer's history + Q&A panel. */
export interface ListingHistoryDTO {
  events: ListingModerationEventDTO[];
  questions: ListingQuestionDTO[];
}

export function toListingHistoryDTO(
  events: ListingModerationEventDTO[],
  questions: ListingQuestionDTO[],
): ListingHistoryDTO {
  return { events, questions };
}
