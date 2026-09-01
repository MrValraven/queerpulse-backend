import { Injectable, Logger } from '@nestjs/common';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import type { SubmissionDeepLinkSource } from './submission-kinds';

/** Same reasoning as `SubmissionDecisionNotifier`'s cap: a bell row carries a
 *  name, and the page one click away carries everything else. */
const MAX_SUBJECT_LABEL_LENGTH = 140;

/** The one argument shape every review-reply emit site calls with. */
export interface ReviewReplyNotice {
  /** The member who WROTE the review, and who is owed the answer. */
  reviewAuthorId: string | null | undefined;
  /**
   * The member the row is allowed to NAME: the business owner, the employer,
   * the housing lister. Becomes `payload.actorId`, which is the field the bell
   * reads to give the row a face, a name and a link to that member's profile.
   *
   * `null` where the row must name nobody. Two cases reach it:
   *  - a MODERATOR wrote the reply, so the row reads as the platform speaking:
   *    the reviewer is owed the answer, never the name of the staff member who
   *    wrote it;
   *  - the reply is published under a business that names nobody, so naming the
   *    member here would out them off the back of a page that does not
   *    (`ListingsService.notifyReviewRepliedBestEffort` decides that, from the
   *    same `isOwnerPubliclyNamed` predicate the public page is built from).
   *
   * PASSING `null` HERE WITHHOLDS A NAME AND NOTHING ELSE. It does not relax
   * the block/mute gate, which reads `blockGateActorId` below.
   */
  replyingSubjectId: string | null | undefined;
  /**
   * The member who actually wrote the reply, whether or not the row is allowed
   * to name them. Passed as `NotificationsService.create`'s `actorId` argument,
   * which is the block/mute gate, so a reviewer who has blocked this member is
   * never reached through the bell. Also what the self-reply guard compares.
   *
   * WHY THIS IS SEPARATE FROM `replyingSubjectId`, which is a correction rather
   * than an addition. One id used to carry both jobs, so the moment a caller
   * passed `null` to withhold a NAME it silently dropped the SAFETY GATE too,
   * and a reviewer who had blocked that owner received the row anyway. Naming
   * and reachability are different questions about the same person and they get
   * different fields.
   *
   * The split is `SafeSpaceVouch`'s, on the record in
   * `notification.entity.ts`: an anonymous vouch omits `voucherId` from the
   * payload so the bell never names the voucher, while still passing them as
   * the `actorId` argument so block/mute fires.
   *
   * Optional, and defaults to `replyingSubjectId`, which is correct for every
   * caller that never withholds a name (the employer and housing reply sites).
   * A caller that DOES withhold one must pass the real member here.
   */
  blockGateActorId?: string | null;
  /**
   * The reviewed thing's own PUBLIC name: the business, the employer, the home.
   * Already published on the page this row links to, which is what makes it
   * safe to carry.
   */
  subjectLabel: string;
  /**
   * Where the bell should point, and the slug it needs. Omit both when the
   * surface has no `sourceHrefFromPayload` branch yet: an honest text-only row
   * beats a link the client silently fails to build.
   */
  deepLinkSource?: SubmissionDeepLinkSource | null;
  deepLinkSlug?: string | null;
}

/**
 * The one place a "the subject of your review has answered it" notification is
 * written (PRD-48).
 *
 * The gap it closes. A business owner's single public reply to a member's
 * review (`ListingsService.replyToReview`) told that member nothing at all, so
 * the only way to discover a reply was to go back and look. The same silence
 * was about to ship twice more, on employer reviews and on reviews of a housing
 * listing, which is exactly the "every intake decides case by case whether the
 * person hears back" pattern PRD-48 names.
 *
 * IT CARRIES AN ACTOR, unlike `SubmissionDecisionNotifier`. This is one member
 * answering another member in public, so `NotificationsService.create`'s
 * block/mute gate has to apply to it the way it applies to
 * `ListingPublicQuestionAnswered` and `ListingReview`.
 *
 * NAMING AND REACHABILITY ARE TWO FIELDS, `replyingSubjectId` and
 * `blockGateActorId`. `replyingSubjectId` decides whether the row NAMES the
 * replier (it becomes `payload.actorId`); `blockGateActorId` decides whether
 * the row REACHES the reviewer at all (it becomes the `actorId` argument). They
 * were one field until a caller withheld a name for a business that names
 * nobody on its public page and, without meaning to, withheld the block/mute
 * gate with it. Same split as `SafeSpaceVouch`, documented in
 * `notification.entity.ts`: an anonymous vouch omits the voucher from the
 * payload and still passes them as the gate's actor.
 *
 * THE REPLY TEXT NEVER RIDES ALONG, and this method takes no parameter for it.
 * It is subject-authored prose, it is already published one click away, and
 * `PAYLOAD_ALLOWLIST` would drop it regardless. There is nothing to pass.
 *
 * BEST EFFORT, ALWAYS: the reply has already committed by the time this is
 * called, so a bell failure is logged and swallowed rather than rolled back
 * onto the owner who wrote it.
 *
 * QueerPulse sends no email and never will, so no copy for this may say
 * anything is on its way.
 */
@Injectable()
export class ReviewReplyNotifier {
  private readonly logger = new Logger(ReviewReplyNotifier.name);

  constructor(private readonly notifications: NotificationsService) {}

  /** Tell the review's author that the subject answered. Never throws. */
  async notifyReviewReplied(notice: ReviewReplyNotice): Promise<void> {
    const { reviewAuthorId, replyingSubjectId } = notice;
    // No author means an imported or anonymised review row with nobody to tell.
    if (!reviewAuthorId) return;
    // The member who really wrote the reply, which is what both the safety gate
    // and the self-reply guard below are asking about. Falls back to the named
    // replier for every caller that withholds nothing.
    const blockGateActorId =
      notice.blockGateActorId ?? replyingSubjectId ?? null;
    // Somebody answering their own review is not news to them. Guarded here
    // rather than at each call site so a future emit site cannot forget it, and
    // read off the REAL member rather than the named one, so a caller
    // withholding a name can never resurrect a self-notification.
    if (blockGateActorId && blockGateActorId === reviewAuthorId) return;

    const subjectLabel = truncate(notice.subjectLabel);
    const deepLinkSource = notice.deepLinkSource ?? null;
    const deepLinkSlug = deepLinkSource ? truncate(notice.deepLinkSlug) : '';

    try {
      await this.notifications.create(
        reviewAuthorId,
        NotificationType.ReviewReplied,
        {
          // Spread only where the row is allowed to name the replier. A
          // moderator-written reply, and a reply published under a business
          // whose public page names nobody, leave `actorId` off the payload
          // entirely, so `actorIdOf` yields `null` and the row names no one.
          ...(replyingSubjectId ? { actorId: replyingSubjectId } : {}),
          ...(subjectLabel ? { subjectLabel } : {}),
          ...(deepLinkSource ? { source: deepLinkSource } : {}),
          ...(deepLinkSlug ? { listingSlug: deepLinkSlug } : {}),
        },
        // The block/mute gate, and the whole reason it is a separate field:
        // this is the member who WROTE the reply, passed even where the payload
        // above named nobody, so withholding a name never quietly withholds the
        // safety gate. Same split as `SafeSpaceVouch`'s anonymous vouch.
        blockGateActorId ?? undefined,
      );
    } catch (error) {
      // Intentionally swallowed: the reply already committed.
      this.logger.warn(
        `Failed to notify ${reviewAuthorId} of a reply to their review: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/** Trim and cap; `''` for anything absent or blank. */
function truncate(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > MAX_SUBJECT_LABEL_LENGTH
    ? trimmed.slice(0, MAX_SUBJECT_LABEL_LENGTH)
    : trimmed;
}
