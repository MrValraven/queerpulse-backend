import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { actorFromLookup, presentActorIds } from '../common/nullable-actor';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { Profile } from '../users/entities/profile.entity';
import {
  HousingListing,
  HousingListingStatus,
} from '../housing-listings/entities/housing-listing.entity';
import { HousingViewingStatus } from '../housing-viewings/entities/housing-viewing.entity';
import { HousingViewingsService } from '../housing-viewings/housing-viewings.service';
import { ReviewReplyNotifier } from '../submissions/review-reply-notifier.service';
import { ReplyToHousingReviewDto } from './dto/reply-to-housing-review.dto';
import { SubmitHousingReviewDto } from './dto/submit-housing-review.dto';
import { UpdateHousingReviewDto } from './dto/update-housing-review.dto';
import {
  HousingReview,
  HousingReviewAuthorRole,
} from './entities/housing-review.entity';
import {
  HousingListingReviewsDTO,
  HousingReviewDTO,
  HousingViewingReviewPairDTO,
  toHousingReviewDTO,
} from './housing-review-response';

/**
 * Two-sided BLIND reviews gated on a completed viewing (P2.4). No completed
 * viewing → no review (the interaction gate). The counterparty's review becomes
 * visible only once BOTH parties have submitted OR the reveal window has
 * elapsed since submission. Aggregate ratings are computed on read over
 * revealed reviews only, never stored as a raw-writable number.
 *
 * REVEAL IS ONE PREDICATE, `isRevealed`, AND IT GOVERNS FOUR THINGS. It began
 * as a read-path rule and is now the hinge the whole surface turns on, so every
 * one of these calls the same private method rather than restating it:
 *
 *  - `forViewing` and `forListing` READ it: nothing is disclosed before it.
 *  - `replyToReview` opens AT it: replying proves the lister read the review,
 *    so a reply before reveal would itself be the leak.
 *  - `updateOwnReview` closes AT it: an edit after reveal would let a member
 *    settle their rating only after reading the counterparty's, which is the
 *    end of blindness however carefully the rest of it is enforced.
 *
 * The last two are exact complements, so on this surface a review can never be
 * edited after it has been answered. That is why
 * `HousingReviewDTO.isEditedAfterListerReply` is structurally false here; see
 * `updateOwnReview` and the field's own note for why it is nevertheless kept.
 */
@Injectable()
export class HousingReviewsService {
  // Anti-retaliation window: a submitted review stays hidden from the
  // not-yet-submitted counterparty for this long, then reveals regardless (so a
  // party who simply never reviews back cannot suppress the other's review
  // forever).
  private static readonly REVEAL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

  // Content-moderation subject types. `housing` keys a takedown on the LISTING
  // (by slug), matching `HousingDirectoryService.SUBJECT_TYPE`; `review` keys a
  // takedown on one review row (by uuid), matching
  // `DirectoryService.REVIEW_SUBJECT_TYPE` on the business side.
  private static readonly LISTING_SUBJECT_TYPE = 'housing';
  private static readonly REVIEW_SUBJECT_TYPE = 'review';

  constructor(
    @InjectRepository(HousingReview)
    private readonly reviews: Repository<HousingReview>,
    @InjectRepository(HousingListing)
    private readonly listings: Repository<HousingListing>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly viewings: HousingViewingsService,
    // BE-HSG-13: the public reviews block honours the same moderator takedowns
    // every other public housing read does.
    private readonly contentModeration: ContentModerationService,
    // PRD-47/PRD-48: the shared "the subject of your review has answered it"
    // row. Shared on purpose — this surface does not get a bespoke
    // notification type of its own.
    private readonly reviewReplyNotifier: ReviewReplyNotifier,
  ) {}

  async submit(
    authorId: string,
    dto: SubmitHousingReviewDto,
  ): Promise<HousingReviewDTO> {
    // Gate: the caller must have a COMPLETED viewing they took part in.
    const viewing = await this.viewings.loadCompletedForReview(
      dto.viewingId,
      authorId,
    );
    const isRequester = viewing.requesterId === authorId;
    const subjectId = isRequester ? viewing.listerId : viewing.requesterId;
    const authorRole = isRequester
      ? HousingReviewAuthorRole.Requester
      : HousingReviewAuthorRole.Lister;
    try {
      const saved = await this.reviews.save(
        this.reviews.create({
          viewingId: viewing.id,
          listingId: viewing.listingId,
          authorId,
          subjectId,
          authorRole,
          rating: dto.rating,
          text: dto.text,
          submittedAt: new Date(),
        }),
      );
      const authors = await this.hydrate(presentActorIds([saved.authorId]));
      return toHousingReviewDTO(
        saved,
        actorFromLookup(authors, saved.authorId) ?? null,
      );
    } catch (err) {
      // Two distinct uniqueness rules land here, and they mean different things
      // to the member, so they get different messages (BE-HSG-09).
      if (isUniqueViolation(err, 'UQ_housing_reviews_listing_author')) {
        throw new ConflictException(
          'You have already reviewed this listing. One review per home, however many times you view it.',
        );
      }
      // One review per party per viewing.
      if (isUniqueViolation(err)) {
        throw new ConflictException('You have already reviewed this viewing');
      }
      throw err;
    }
  }

  /**
   * The LISTER answers a guest's review of their home, in public (PRD-47).
   *
   * ---------------------------------------------------------------------
   * WHY THIS EXISTS
   * ---------------------------------------------------------------------
   * Five rating primitives across the verticals and only the business
   * directory let the subject say anything back. A cafe could answer a bad
   * review; the person whose home was reviewed could not. The product decision
   * is one reply, from the subject only, labelled as the subject, reportable.
   * The shape follows `ListingsService.replyToReview` deliberately so the two
   * verticals cannot drift.
   *
   * ---------------------------------------------------------------------
   * THE RULE THIS SURFACE HAS AND THE DIRECTORY DOES NOT: BLINDNESS
   * ---------------------------------------------------------------------
   * Housing reviews are blind and mutual. Both parties review each other after
   * a completed viewing and neither sees the other's words until both have
   * submitted or the anti-retaliation window elapses. A reply is an act that
   * PROVES the lister has read the review. If they could reply while the review
   * was still blind, the reply would itself be the leak: it tells the guest
   * their review has been read, and a lister who wanted to could use it to
   * signal or to pressure a guest who has not filed theirs yet.
   *
   * So a reply is refused until the review has REVEALED, and reveal is not
   * assumed — it is the same `isRevealed` predicate the reads use, evaluated
   * here against a COUNT over the whole viewing rather than a page of rows:
   *
   *   revealed  ==  both parties submitted  OR  the window elapsed
   *
   * That predicate is also exactly what `forListing` filters the public block
   * on, which is the useful part: a reply becomes possible at the same instant
   * the review acquires a public audience, and never one moment before. The
   * right of reply exists precisely where there is something public to answer.
   *
   * ---------------------------------------------------------------------
   * ONLY ON A GUEST→LISTER REVIEW
   * ---------------------------------------------------------------------
   * The guest→lister review is the one the public listing aggregates. The
   * lister→guest review stays between the two parties and has no public reader
   * to correct, so a "reply" on it would just be a second private message
   * between two people who already have a thread. It is refused, with its own
   * message rather than the generic ownership one, because the caller IS the
   * subject there and deserves to be told why.
   *
   * ---------------------------------------------------------------------
   * REPORTING AND MODERATION
   * ---------------------------------------------------------------------
   * The reply is covered by the review's OWN `review` report subject, the same
   * subject `dropModeratedReviews` already filters this listing's block on. No
   * new subject is added, and that is the deliberate reading of the taxonomy
   * rather than an omission: `ReportSubjectType.Review` says in as many words
   * that "a review's owner reply is not separately takedown-able, because a
   * reply read without the review it answers is not the same statement".
   * Because `listerReply` is nested inside `HousingReviewDTO`, a `hide_content`
   * or `remove_content` on the review takes the reply down with it, and neither
   * the review nor the reply then skews the average. Adding a subject here
   * would be a curated list drifting from the taxonomy it mirrors, which has
   * cost this platform a report band before.
   *
   * OVERWRITES rather than threads: posting again replaces the text and
   * re-stamps the time. One reply, as decided.
   */
  async replyToReview(
    reviewId: string,
    userId: string,
    dto: ReplyToHousingReviewDto,
  ): Promise<HousingReviewDTO> {
    const review = await this.reviews.findOne({ where: { id: reviewId } });
    if (!review) {
      throw new NotFoundException('Review not found');
    }
    // 403 rather than a don't-leak-existence 404: a review id is a uuid already
    // published in this listing's public reviews block, so there is no
    // existence to protect and a 403 says what actually happened. Same call
    // `DirectoryService.updateReview` makes.
    if (review.subjectId !== userId) {
      throw new ForbiddenException('You can only reply to a review about you');
    }
    if (review.authorRole !== HousingReviewAuthorRole.Requester) {
      throw new ForbiddenException(
        'This review is private between the two of you. Reply in your messages instead.',
      );
    }
    // THE TAKEDOWN GATE. A review a moderator has hidden or removed has no
    // public reader left to correct: `forListing` drops it, and the reply
    // nested inside `HousingReviewDTO` goes down with it. Without this check
    // the lister could still write into it, and `notifyReviewAuthorOfReply`
    // would tell the guest their review had been answered while pointing at
    // something nobody can read. A 404 rather than a 403, matching the posture
    // every other read takes on taken-down content (`forListing` above,
    // `LandlordsService.loadLiveOr404`): a withheld thing reads as absent
    // rather than as a tombstone that confirms a report landed.
    const reviewModeration = await this.contentModeration.stateFor(
      HousingReviewsService.REVIEW_SUBJECT_TYPE,
      review.id,
    );
    if (reviewModeration.hidden || reviewModeration.removed) {
      throw new NotFoundException('Review not found');
    }
    // The blindness gate. Counted over the whole viewing, never over a page.
    const submittedCount = await this.reviews.count({
      where: { viewingId: review.viewingId },
    });
    if (!this.isRevealed(review, submittedCount >= 2)) {
      throw new ForbiddenException(
        'This review has not been revealed yet. You can answer it once it is.',
      );
    }

    // `@IsNotEmpty` rejects `''` but not `' '`, which trims to nothing and
    // would strand a real `listerRepliedAt` beside a reply that renders blank
    // (`toHousingReviewDTO` maps empty text to `listerReply: null`). Re-check
    // post-trim, exactly as the business side does.
    const text = dto.text.trim();
    if (!text) {
      throw new BadRequestException('Reply cannot be empty');
    }

    review.listerReplyText = text;
    review.listerRepliedAt = new Date();
    const saved = await this.reviews.save(review);

    // The reply's author is the lister, but the returned row still represents
    // the GUEST who wrote the review — resolve their profile so the row keeps
    // its name and photo. `authorId` is null once that member erased their
    // account, and `actorFromLookup` turns that into the same `null` a missing
    // profile produces, so the caller renders a removed-member placeholder
    // rather than reaching for an id that no longer points anywhere.
    const authors = await this.hydrate(presentActorIds([saved.authorId]));
    const dtoOut = toHousingReviewDTO(
      saved,
      actorFromLookup(authors, saved.authorId) ?? null,
    );

    await this.notifyReviewAuthorOfReply(saved);
    return dtoOut;
  }

  /**
   * The GUEST (or lister) edits their OWN review, and ONLY while it is still
   * blind.
   *
   * ---------------------------------------------------------------------
   * WHY AN EDIT PATH EXISTS
   * ---------------------------------------------------------------------
   * A member gets exactly one review per listing
   * (`UQ_housing_reviews_listing_author`). Without an edit path that meant the
   * one review someone ever wrote about a home stood unchanged forever: a typo,
   * a rating typed on the wrong row, a sentence they thought better of an hour
   * later. The one-review rule is worth keeping, and this is what makes it fair
   * to keep.
   *
   * ---------------------------------------------------------------------
   * EDITS CLOSE AT REVEAL. THIS IS THE WHOLE RULE.
   * ---------------------------------------------------------------------
   * Housing reviews are blind and mutual: neither party sees the other's words
   * until both have submitted or the anti-retaliation window elapses. An edit
   * path that stayed open past that moment would have quietly ended blindness,
   * because a guest could read the lister's review of them and only THEN settle
   * on their own rating. The window that exists to stop retaliation would have
   * become the window in which to aim it.
   *
   * So the edit closes at exactly the instant the review acquires a reader:
   *
   *   editable  ==  NOT (both parties submitted  OR  the window elapsed)
   *
   * That is the same `isRevealed` predicate `forViewing`, `forListing` and
   * `replyToReview` evaluate, called here rather than restated. A second copy
   * of the reveal rule sitting beside the first is the drift shape this
   * codebase has paid for before: the two copies agree on the day they are
   * written and disagree the day one of them is tuned. Pair completeness is
   * counted over the WHOLE viewing, never over a page of rows, for the same
   * reason `replyToReview` counts it that way.
   *
   * You can fix a typo until your review goes public. After that it stands, and
   * the reader of a public review is entitled to the words that were actually
   * filed.
   *
   * ---------------------------------------------------------------------
   * WHAT THIS DOES TO THE LISTER REPLY: THE TWO CAN NO LONGER OVERLAP
   * ---------------------------------------------------------------------
   * A reply is refused BEFORE reveal and an edit is refused AFTER it, so the
   * two are now disjoint in time and no review can ever be edited after it has
   * been answered. Reveal is monotonic (a submitted row is never deleted, only
   * unattributed by erasure, and elapsed time does not run backwards), so this
   * is a structural guarantee rather than a race the code happens to win.
   *
   * Two consequences, both deliberate:
   *
   *  - The keep-the-reply behaviour below STAYS. An edit still never touches
   *    `listerReplyText` or `listerRepliedAt`. It is now unreachable defence,
   *    and it is kept precisely because it is the line that would matter on the
   *    day the reveal gate is loosened. Deleting a guard because the gate in
   *    front of it currently holds is how the guard is missing when the gate
   *    moves.
   *  - `HousingReviewDTO.isEditedAfterListerReply` can no longer be true on
   *    this surface. It is kept, honestly derived from the two timestamps
   *    rather than hardcoded to `false`. See the note on that field in
   *    `housing-review-response.ts` for why keeping it is the honest call.
   *
   * `editedAt` itself is still stamped and still rendered ("edited on ..."),
   * because a pre-reveal edit is a real thing that happened to a review a
   * counterparty may later read. It is stamped ONLY when something actually
   * changed, so re-saving an identical body writes no stamp.
   *
   * Nothing is hidden and nothing is versioned. Publishing prior revisions
   * would mean publishing text a member has actively withdrawn, which on this
   * platform is a worse failure than the ordering problem it solves.
   *
   * ---------------------------------------------------------------------
   * A TAKEN-DOWN REVIEW IS STILL EDITABLE BY ITS AUTHOR, ON PURPOSE
   * ---------------------------------------------------------------------
   * `replyToReview` 404s on a moderated review and this does not, and the
   * asymmetry is the point rather than an omission.
   *
   * A takedown withholds content from its AUDIENCE, and a member is not their
   * own audience. `forViewing` already says so out loud: it drops the
   * counterparty's moderated review and deliberately KEEPS `yourReview` for the
   * person who wrote it. Refusing the edit with a 404 would contradict the
   * screen that member is looking at, telling them their own review had
   * vanished while it is still on the page in front of them.
   *
   * The edit is also harmless. A reply is a public act that fires a
   * notification at a reader who no longer exists, which is why it is refused.
   * An edit notifies nobody, and it cannot lift the takedown:
   * `dropModeratedReviews` keys on the review id, which an edit does not
   * change. What it CAN do is let someone fix the thing that got their review
   * hidden, and a takedown is reversible (deleting the moderation row restores
   * the content), so a member with no way to correct their words would be the
   * worse outcome. The reveal gate above still applies first, so in practice
   * only a still-blind review is reachable here at all.
   *
   * The aggregate needs no maintenance here by design: there is no stored
   * rating column, `forListing` recomputes the mean from the revealed rows
   * themselves, so changing `rating` IS the aggregate update.
   */
  async updateOwnReview(
    reviewId: string,
    userId: string,
    dto: UpdateHousingReviewDto,
  ): Promise<HousingReviewDTO> {
    const review = await this.reviews.findOne({ where: { id: reviewId } });
    if (!review) {
      throw new NotFoundException('Review not found');
    }
    // `authorId` is nullable, so the null case is checked explicitly: an erased
    // author's review belongs to nobody and must never fall to whoever asks.
    if (!review.authorId || review.authorId !== userId) {
      throw new ForbiddenException('You can only edit your own review');
    }

    // THE REVEAL GATE. `isRevealed` is the one predicate the read paths use;
    // this calls it rather than restating the rule. Counted over the whole
    // viewing, exactly as `replyToReview` counts it, so a review whose pair
    // straddles a page boundary can never read as still-blind here.
    //
    // A 409 on purpose, and the third distinct status this endpoint returns:
    // 404 means no such review, 403 means it is not yours, 409 means it is
    // yours and it exists and the state it is in no longer accepts a change.
    // Collapsing this into the 403 would tell a member they lack permission
    // over their own words, which is both untrue and the wrong thing to read
    // when the honest answer is "you are a few hours late".
    const submittedCount = await this.reviews.count({
      where: { viewingId: review.viewingId },
    });
    if (this.isRevealed(review, submittedCount >= 2)) {
      throw new ConflictException(
        'This review has gone public, so it can no longer be changed. A review can be corrected up until the moment it goes public.',
      );
    }

    // Trimmed, but an empty body is legitimate here: `SubmitHousingReviewDto`
    // sets no minimum, so a rating with no words is a review this surface
    // accepts and an edit must be able to reach the same state.
    const text = dto.text.trim();
    const isChanged = review.rating !== dto.rating || review.text !== text;

    review.rating = dto.rating;
    review.text = text;
    if (isChanged) {
      review.editedAt = new Date();
    }
    const saved = await this.reviews.save(review);

    const authors = await this.hydrate(presentActorIds([saved.authorId]));
    return toHousingReviewDTO(
      saved,
      actorFromLookup(authors, saved.authorId) ?? null,
    );
  }

  /**
   * The blind-review pair for one viewing, from the caller's perspective.
   *
   * TWO INDEPENDENT GATES RUN HERE AND THEY ANSWER DIFFERENT QUESTIONS. Keeping
   * them apart is the whole of this method's correctness.
   *
   *  - The BLIND gate (`isRevealed`) decides WHEN the counterparty's review
   *    unlocks. It is evaluated over every row on the viewing, moderated ones
   *    included, because it is a question about reciprocity: a review a
   *    moderator later took down was still submitted, and dropping it from the
   *    pair count would quietly re-blind a review that had already unlocked and
   *    restart a fourteen-day window that had already run.
   *  - The TAKEDOWN gate (`dropModeratedReviews`) decides WHAT the caller may
   *    read. `forListing` has run it since BE-HSG-13 and this pair view never
   *    did, so a hidden review disappeared from the public block while the one
   *    person it is actually about went on reading it here. On a housing
   *    surface that is the takedown failing in the place it most needed to
   *    work, and it is what PRD-47d closed.
   *
   * WHOSE REVIEW THE TAKEDOWN WITHHOLDS, AND WHOSE IT DELIBERATELY DOES NOT.
   *
   * `counterpartyReview` is dropped, and `counterpartySubmitted` and
   * `revealsAt` go with it, so a taken-down review reads as ABSENT rather than
   * as a tombstone. That is the posture every other surface takes (see
   * `DirectoryService`: a hidden or removed question simply stops rendering).
   * Leaving `counterpartySubmitted` true beside a null review would strand the
   * reader on "they have left a review, it unlocks when you leave yours"
   * forever, which is a worse answer than "nothing here".
   *
   * `yourReview` is KEPT for its own author, and that is not an oversight. A
   * takedown withholds content from its AUDIENCE, and a member is not their own
   * audience: they wrote the words, and hiding them back explains nothing while
   * removing the only copy they can read. It also has to stay, because
   * `canReview` and `youReviewed` are governed by
   * `UQ_housing_reviews_listing_author`, which still holds the slot after a
   * takedown. Dropping the row would offer a review form that the unique index
   * answers with a 409.
   *
   * AND THE PAIR NOW ANSWERS ONE QUESTION ABOUT THE CALLER'S OWN REVIEW:
   * `isYourReviewRevealed`. Every other field here describes the counterparty,
   * so a client deciding whether to offer the edit control had to infer its own
   * review's state from `counterpartySubmitted`, which cannot express the
   * elapsed-window half of the reveal rule. A review whose counterparty never
   * wrote one and whose window had run out was public and still looked editable
   * on the wire, so the UI offered a save that `updateOwnReview` then refused.
   * The field is the same `isRevealed` call that PATCH gates on, over the same
   * raw-row count, which is what makes the control correct at render time. It
   * follows the BLIND gate and not the TAKEDOWN gate, so it can read true
   * beside `counterpartySubmitted: false`; that is the two gates answering
   * their own questions, and the field's own note says why.
   */
  async forViewing(
    viewingId: string,
    userId: string,
  ): Promise<HousingViewingReviewPairDTO> {
    // Participation check (throws 404/403 as appropriate).
    const viewing = await this.viewings.loadParticipantViewing(
      viewingId,
      userId,
    );
    const rows = await this.reviews.find({ where: { viewingId } });
    // Counted over the raw rows on purpose. See the blind-gate note above.
    const bothSubmitted = rows.length >= 2;
    const yours = rows.find((row) => row.authorId === userId) ?? null;
    const counterparty = rows.find((row) => row.authorId !== userId) ?? null;
    // The takedown gate, run over the counterparty's row only.
    const visibleCounterparty = counterparty
      ? await this.dropModeratedReviews([counterparty])
      : [];
    const theirs = visibleCounterparty[0] ?? null;
    const theirsRevealed =
      theirs !== null && this.isRevealed(theirs, bothSubmitted);
    // THE CALLER'S OWN REVEAL STATE, which is the same thing as "has your edit
    // window closed" (`updateOwnReview` refuses at exactly this predicate).
    // Same `isRevealed` call, counted over the RAW rows, so it agrees with the
    // gate the PATCH will apply rather than approximating it. Note that this
    // deliberately does NOT follow `theirs`: a taken-down counterparty review
    // is withheld from display below while still counting for reciprocity here.
    // See the field's own note in `housing-review-response.ts`.
    const isYourReviewRevealed =
      yours !== null && this.isRevealed(yours, bothSubmitted);

    // `authorId` is NULL once the reviewer erased their account
    // (`SetNullContentAuthorFksOnUserErasure1794610000000`): the review
    // survives, unattributed, because the next tenant still needs to read it.
    const authorIds = presentActorIds(
      [yours, theirs]
        .filter((row): row is HousingReview => row !== null)
        .map((row) => row.authorId),
    );
    const authors = await this.hydrate(authorIds);

    return {
      viewingId,
      canReview:
        viewing.status === HousingViewingStatus.Completed && yours === null,
      youReviewed: yours !== null,
      yourReview: yours
        ? toHousingReviewDTO(
            yours,
            actorFromLookup(authors, yours.authorId) ?? null,
          )
        : null,
      isYourReviewRevealed,
      counterpartySubmitted: theirs !== null,
      counterpartyReview:
        theirs && theirsRevealed
          ? toHousingReviewDTO(
              theirs,
              actorFromLookup(authors, theirs.authorId) ?? null,
            )
          : null,
      revealsAt:
        theirs && !theirsRevealed
          ? new Date(
              theirs.submittedAt.getTime() +
                HousingReviewsService.REVEAL_WINDOW_MS,
            ).toISOString()
          : null,
    };
  }

  /**
   * Public reviews block for a listing: the revealed guest→lister reviews plus
   * the aggregate computed over them. Reviews about the lister are revealed per
   * the same blind rule (their pair is complete, or the window elapsed).
   *
   * BE-HSG-13 closed three holes here. The listing lookup had no `status` filter
   * and no takedown check, so reviews stayed publicly readable for a listing a
   * moderator had hidden or that had never cleared review at all, while every
   * read in `HousingDirectoryService` refused it. Individual reviews carried no
   * takedown exclusion either, unlike business reviews
   * (`DirectoryService.dropModeratedReviews`). And pair-completeness was counted
   * from the same 200-row page as the display, so on a busy listing a viewing
   * whose two reviews straddled the page boundary read as single-sided and the
   * blind-reveal rule was evaluated on incomplete data.
   */
  async forListing(
    slug: string,
    viewerUserId: string | null,
  ): Promise<HousingListingReviewsDTO> {
    const listing = await this.listings.findOne({
      where: { slug, status: HousingListingStatus.Live },
    });
    if (!listing) {
      throw new NotFoundException('Housing listing not found');
    }
    // Same withhold-entirely behaviour as the public detail read: a moderator
    // takedown on the listing 404s its reviews too.
    const listingModeration = await this.contentModeration.stateFor(
      HousingReviewsService.LISTING_SUBJECT_TYPE,
      slug,
    );
    if (listingModeration.hidden || listingModeration.removed) {
      throw new NotFoundException('Housing listing not found');
    }
    // Pair-completeness is counted over ALL of the listing's reviews in one
    // grouped query, NOT over the display page below: a viewing whose two
    // reviews straddle the page boundary must not read as single-sided.
    const pairCounts = await this.reviews
      .createQueryBuilder('r')
      .select('r.viewing_id', 'viewingId')
      .addSelect('COUNT(*)', 'count')
      .where('r.listing_id = :listingId', { listingId: listing.id })
      .groupBy('r.viewing_id')
      .getRawMany<{ viewingId: string; count: string }>();
    const submittedCountByViewing = new Map<string, number>(
      // Annotated as a tuple: without it TypeScript widens the element to
      // `(string | number)[]`, which the Map constructor does not accept.
      pairCounts.map((row): [string, number] => [
        row.viewingId,
        Number(row.count),
      ]),
    );
    // The display page: reviews tied to this listing, newest first.
    const all = await this.reviews.find({
      where: { listingId: listing.id },
      order: { submittedAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    // Public display = reviews ABOUT the lister that have passed the blind gate.
    const candidates = all.filter(
      (row) =>
        row.subjectId === listing.ownerId &&
        this.isRevealed(
          row,
          (submittedCountByViewing.get(row.viewingId) ?? 0) >= 2,
        ),
    );
    // A taken-down review never renders AND never skews the average, mirroring
    // `DirectoryService.dropModeratedReviews` on the business side.
    const revealed = await this.dropModeratedReviews(candidates);
    const authors = await this.hydrate(
      presentActorIds(revealed.map((row) => row.authorId)),
    );
    const averageRating =
      revealed.length === 0
        ? null
        : Math.round(
            (revealed.reduce((sum, row) => sum + row.rating, 0) /
              revealed.length) *
              10,
          ) / 10;
    return {
      averageRating,
      count: revealed.length,
      reviews: revealed.map((row) =>
        toHousingReviewDTO(row, actorFromLookup(authors, row.authorId) ?? null),
      ),
      // Who may write the reply (PRD-47). Every row above is already a
      // guest→lister review about `listing.ownerId` that has passed the blind
      // gate, so this one boolean is the whole answer for the block and cannot
      // drift from the rows beside it. `ownerId` is nullable, so the null-owner
      // listing resolves to `false` rather than matching a null viewer.
      isViewerTheLister:
        listing.ownerId !== null && listing.ownerId === viewerUserId,
    };
  }

  // --- internals ---

  /**
   * Tell the guest that the lister answered their review (PRD-47/PRD-48).
   *
   * The SHARED `ReviewReplied` row, never a housing-specific notification type:
   * the whole point of the shared notifier is that every vertical's right of
   * reply reaches the reviewer the same way. The notifier itself already drops
   * an authorless row and a self-reply, so those are not re-checked here.
   *
   * NO DEEP LINK, on purpose. `SubmissionDeepLinkSource` is
   * `listing | community | event | job` and the frontend's
   * `sourceHrefFromPayload` resolves only those, so claiming `housing` here
   * would render a row that looks clickable and silently is not. An honest
   * text-only row naming the home beats a dead link. When a housing branch is
   * added to the frontend resolver and to that union, this call site sets
   * `deepLinkSource`/`deepLinkSlug` and nothing else changes.
   *
   * BEST EFFORT, ALWAYS: the reply has already committed. `notifyReviewReplied`
   * never throws, and the listing lookup that feeds it is guarded too, so a
   * missing home cannot fail a reply the lister has already published.
   */
  private async notifyReviewAuthorOfReply(
    review: HousingReview,
  ): Promise<void> {
    if (!review.authorId) return;
    try {
      const listing = await this.listings.findOne({
        where: { id: review.listingId },
        select: { title: true },
      });
      await this.reviewReplyNotifier.notifyReviewReplied({
        reviewAuthorId: review.authorId,
        replyingSubjectId: review.subjectId,
        subjectLabel: listing?.title ?? '',
      });
    } catch {
      // Intentionally ignored — the reply already committed. `notifyReviewReplied`
      // swallows its own failures; the try still has to be here because the
      // listing read that feeds it does not, and a missing home must not fail a
      // reply the lister has already published.
    }
  }

  /**
   * A review is revealed when its pair is complete, or the anti-retaliation
   * window has elapsed since submission.
   *
   * THE SINGLE COPY of that rule. Reads gate disclosure on it, `replyToReview`
   * opens on it and `updateOwnReview` closes on it, so a change here moves all
   * four together and none of them can drift out from under the others. Both
   * inputs are monotonic (a submitted row is never deleted, and elapsed time
   * does not run backwards), so a revealed review never becomes blind again.
   */
  private isRevealed(review: HousingReview, bothSubmitted: boolean): boolean {
    if (bothSubmitted) return true;
    return (
      Date.now() - review.submittedAt.getTime() >=
      HousingReviewsService.REVEAL_WINDOW_MS
    );
  }

  /** Drops any review carrying a `review` takedown, so it neither renders nor
   * skews the derived average. Mirrors `DirectoryService.dropModeratedReviews`
   * exactly (BE-HSG-13). */
  private async dropModeratedReviews(
    reviews: HousingReview[],
  ): Promise<HousingReview[]> {
    if (!reviews.length) return reviews;
    const states = await this.contentModeration.statesFor(
      HousingReviewsService.REVIEW_SUBJECT_TYPE,
      reviews.map((review) => review.id),
    );
    return reviews.filter((review) => {
      const state = states.get(review.id);
      return !state || (!state.hidden && !state.removed);
    });
  }

  private async hydrate(userIds: string[]): Promise<Map<string, MemberRef>> {
    if (!userIds.length) return new Map();
    return new MemberLookup(this.profiles).byUserIds([...new Set(userIds)]);
  }
}
