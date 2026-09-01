import { MemberRef } from '../common/member-ref';
import {
  HousingReview,
  HousingReviewAuthorRole,
} from './entities/housing-review.entity';

/**
 * The LISTER's single public reply to a review of their home (PRD-47).
 *
 * Deliberately labelled `listerReply` rather than a neutral `reply`: whoever
 * renders it has to be able to say on the page that these words come from the
 * subject of the review, so a reader never mistakes the reply for a second
 * reviewer agreeing.
 */
export interface HousingReviewListerReplyDTO {
  text: string;
  /** ISO-8601, when the lister wrote (or last overwrote) it. */
  at: string;
}

/** A single revealed review — the author is only ever attached once the blind
 * gate has opened, so an author is never disclosed alongside hidden content. */
export interface HousingReviewDTO {
  id: string;
  /** `null` for a review whose author has since erased their account
   * (`authorId` is `ON DELETE SET NULL`). Render a removed-member placeholder;
   * never assume an id is there. */
  author: MemberRef | null;
  authorRole: HousingReviewAuthorRole;
  rating: number;
  text: string;
  submittedAt: string;
  /** When the author last changed it, ISO-8601, or `null` if never. */
  editedAt: string | null;
  /**
   * True when `editedAt` is later than `listerRepliedAt`: the review changed
   * AFTER the lister answered it, so the reply on screen may be answering words
   * that are no longer there. Precomputed here rather than left as a timestamp
   * comparison for each client to get right (or not). Always `false` when there
   * is no reply or no edit.
   *
   * ON HOUSING THIS IS STRUCTURALLY FALSE, AND IT IS KEPT ANYWAY.
   *
   * Since edits close at reveal (`HousingReviewsService.updateOwnReview`) and
   * replies open at reveal (`replyToReview`), the two windows are exact
   * complements and no housing review can be edited after it has been answered.
   * A reader of this interface deserves to know that rather than to infer a
   * capability from a field, which is why it is written here in as many words.
   *
   * Kept, for three reasons that outweigh the tidiness of deleting it:
   *
   *  1. It is DERIVED, never stored. It reports what the two timestamps
   *     actually say, so it is not a claim the API cannot keep: it is a claim
   *     about data, and it is true whenever the data is. Hardcoding `false`
   *     would be the dishonest version. Removing it would leave any row that
   *     ever does carry that ordering (a support-led data fix, a backfill, a
   *     replica clock) rendering with no warning at all.
   *  2. Removing it costs a schema decision it does not deserve. The field is
   *     computed from `editedAt` and `listerRepliedAt`, both of which stay:
   *     `editedAt` still records pre-reveal edits and still renders as
   *     "edited on ...". So deleting the boolean would drop a wire field while
   *     changing nothing about the table, and the column removal that a reader
   *     might imagine follows from it would be a migration on a shipped table
   *     for zero gain.
   *  3. It keeps this DTO parallel to the business directory's, which is the
   *     one place edits and replies DO overlap. The two verticals were built to
   *     the same shape on purpose (see `replyToReview`), and if housing's edit
   *     policy is ever loosened the flag is already correct rather than
   *     something to re-derive under pressure.
   */
  isEditedAfterListerReply: boolean;
  /** The lister's public answer, or `null` when they have not written one. */
  listerReply: HousingReviewListerReplyDTO | null;
}

/**
 * Was this review changed after the lister's reply was written?
 *
 * The two timestamps are independent and either can move, so the comparison is
 * done once, here, and shipped as a boolean. A review with no reply, or a reply
 * with no subsequent edit, is `false`.
 *
 * Left as a real comparison rather than shortened to `return false`, even
 * though the housing edit and reply windows no longer overlap: this answers
 * what the row says, and a row that ever says otherwise should say so on the
 * page. See the field's note above.
 */
function isEditedAfterListerReply(review: HousingReview): boolean {
  if (!review.listerReplyText || !review.listerRepliedAt || !review.editedAt) {
    return false;
  }
  return review.editedAt.getTime() > review.listerRepliedAt.getTime();
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
    editedAt: review.editedAt ? review.editedAt.toISOString() : null,
    isEditedAfterListerReply: isEditedAfterListerReply(review),
    // Truthy check on the text, so the timestamp can never publish a blank
    // reply on its own. `replyToReview` refuses to write one, and this is the
    // second line of that same defence.
    listerReply: review.listerReplyText
      ? {
          text: review.listerReplyText,
          at: review.listerRepliedAt!.toISOString(),
        }
      : null,
  };
}

/**
 * The blind-review pair for ONE viewing, from the caller's perspective. The
 * caller always sees their own review; the counterparty's `review` is present
 * only once revealed (both submitted, or the window elapsed). When the
 * counterparty has submitted but it's still blind, `counterpartySubmitted` is
 * true while `counterpartyReview` stays null — so the UI can honestly say
 * "they've left a review; it unlocks when you leave yours".
 *
 * A MODERATOR TAKEDOWN ON THE COUNTERPARTY'S REVIEW CLEARS ALL THREE OF THOSE
 * FIELDS (PRD-47d): `counterpartySubmitted` false, `counterpartyReview` null,
 * `revealsAt` null. A hidden review reads as absent here exactly as it does in
 * the public block, so the person it is about cannot go on reading something a
 * moderator took down. `yourReview` is never withheld from its own author, and
 * `canReview`/`youReviewed` still track the row itself, because the one review
 * per listing slot stays taken after a takedown. `isYourReviewRevealed` is NOT
 * cleared either, and that is the interesting one: it answers the blind gate,
 * which counts raw rows, so a takedown cannot re-blind a review that had
 * already gone public. Its own note below has the reasoning.
 */
export interface HousingViewingReviewPairDTO {
  viewingId: string;
  canReview: boolean;
  youReviewed: boolean;
  yourReview: HousingReviewDTO | null;
  /**
   * Has the CALLER'S OWN review gone public, which is the same thing as saying
   * their edit window has closed (`HousingReviewsService.updateOwnReview`)?
   * `false` when they have not written one, because there is nothing to reveal.
   *
   * WHY THIS FIELD EXISTS. Every other field on this DTO answers a question
   * about the COUNTERPARTY, and a client trying to decide whether to offer an
   * edit control was left inferring its own review's state from them. It could
   * not: `counterpartySubmitted` is a sound positive signal (their row existing
   * means both submitted, and both reveal together) and no signal at all in the
   * other direction, because the second half of the reveal rule is an elapsed
   * anti-retaliation window whose length lives only in the service. So a review
   * whose counterparty never wrote one and whose window has since run out was
   * public on the server and still looked editable on the wire, and the UI
   * offered a save control that the 409 then refused. A control that is offered
   * and then refuses is the bug; this field is the fix.
   *
   * A BOOLEAN RATHER THAN AN `editableUntil` TIMESTAMP, DELIBERATELY. A
   * deadline would let the UI count the member down, and it would reintroduce
   * the exact failure being closed here: reveal is decided by the SERVER's
   * clock, so a client running even slightly ahead would read a deadline that
   * has not passed for the server as passed (or, worse, the reverse) and go on
   * offering an edit that 409s. Reveal also has a second trigger that no
   * timestamp can express, the counterparty submitting at a moment nobody can
   * predict, so a countdown would be a promise this surface cannot keep. The
   * boolean is the server's answer to the server's own question, evaluated at
   * read time, and it cannot be misread.
   *
   * DERIVED FROM `isRevealed`, THE ONE COPY OF THE REVEAL RULE. Not restated
   * here, and `REVEAL_WINDOW_MS` is deliberately NOT published to clients: a
   * predicate duplicated across the wire agrees on the day it is written and
   * drifts the day one copy is tuned, and the window is a policy the server
   * owns.
   *
   * IT IS COMPUTED OVER THE RAW ROWS, AND `counterpartySubmitted` IS NOT. THE
   * TWO ARE ALLOWED TO DISAGREE, AND IT IS NOT A BUG. A moderator takedown on
   * the counterparty's review clears `counterpartySubmitted` (see the note
   * below), because a takedown withholds content from its audience. Reveal is a
   * different question: it asks whether reciprocity happened, and a review a
   * moderator later took down was still SUBMITTED. Counting the blind gate over
   * the surviving rows would quietly re-blind a review that had already gone
   * public and restart a fourteen-day window that had already run, so
   * `forViewing` counts it over the raw rows and this field follows that count.
   * The visible result: a taken-down counterparty review reads as
   * `counterpartySubmitted: false` beside `isYourReviewRevealed: true`, which
   * is both fields telling the truth about two different questions.
   */
  isYourReviewRevealed: boolean;
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
  /**
   * True when the caller is the lister these reviews are about, which is
   * exactly the set of people entitled to write or change the reply (PRD-47).
   *
   * A block-level flag rather than a per-review one on purpose: every review in
   * this array has already passed `subjectId === listing.ownerId` and the blind
   * reveal gate, so the answer is the same for all of them and one boolean
   * cannot drift from the rows beside it. `false` for every other reader,
   * including a signed-out one, so the compose affordance never renders for
   * somebody the endpoint would refuse.
   */
  isViewerTheLister: boolean;
}
