import { MemberRef } from '../common/member-ref';
import {
  HousingReview,
  HousingReviewAuthorRole,
} from './entities/housing-review.entity';

/** A single revealed review — the author is only ever attached once the blind
 * gate has opened, so an author is never disclosed alongside hidden content. */
export interface HousingReviewDTO {
  id: string;
  author: MemberRef | null;
  authorRole: HousingReviewAuthorRole;
  rating: number;
  text: string;
  submittedAt: string;
}

export function toHousingReviewDTO(
  review: HousingReview,
  author: MemberRef | null,
): HousingReviewDTO {
  return {
    id: review.id,
    author,
    authorRole: review.authorRole,
    rating: review.rating,
    text: review.text,
    submittedAt: review.submittedAt.toISOString(),
  };
}

/**
 * The blind-review pair for ONE viewing, from the caller's perspective. The
 * caller always sees their own review; the counterparty's `review` is present
 * only once revealed (both submitted, or the window elapsed). When the
 * counterparty has submitted but it's still blind, `counterpartySubmitted` is
 * true while `counterpartyReview` stays null — so the UI can honestly say
 * "they've left a review; it unlocks when you leave yours".
 */
export interface HousingViewingReviewPairDTO {
  viewingId: string;
  canReview: boolean;
  youReviewed: boolean;
  yourReview: HousingReviewDTO | null;
  counterpartySubmitted: boolean;
  counterpartyReview: HousingReviewDTO | null;
  /** ISO time the blind window opens for a submitted-but-hidden counterparty
   * review, or null when there's nothing pending to reveal. */
  revealsAt: string | null;
}

/** The public reviews block for a listing — the aggregate + the revealed
 * guest→lister reviews. Aggregate is computed on read over REVEALED reviews
 * only, never stored. */
export interface HousingListingReviewsDTO {
  /** Mean of revealed ratings, rounded to one decimal, or null when none are
   * revealed yet. */
  averageRating: number | null;
  count: number;
  reviews: HousingReviewDTO[];
}
