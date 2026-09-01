import { Injectable, Logger } from '@nestjs/common';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  SUBMISSION_KIND_NOTIFICATION,
  SubmissionKind,
  SubmissionOutcome,
} from './submission-kinds';

/**
 * How much of a label or a reviewer note a bell row will carry.
 *
 * A cap rather than a validation error: this is the LAST step of an admin's
 * decision, and a note four screens long must not be the reason the decision
 * itself fails. The full text stays on the intake's own row either way.
 */
const MAX_SUBJECT_LABEL_LENGTH = 140;
const MAX_REVIEW_NOTE_LENGTH = 500;

/** The one argument shape every adopting intake calls with. */
export interface SubmissionDecisionNotice {
  /** The member who submitted, and who is owed the answer. */
  recipientId: string;
  /** Which intake this was. */
  kind: SubmissionKind;
  /** How it ended, mapped from this intake's own status vocabulary. */
  outcome: SubmissionOutcome;
  /**
   * The submission's own headline, read back to the member so the row says
   * WHICH submission: the organisation they applied on behalf of, the listing
   * they proposed a swap against, the resource they suggested.
   *
   * The member's own words in most cases, which is exactly why it is safe to
   * show them: `StorySubmissionDecided`'s `workingTitle` and
   * `ReadingGroupProposalDecided`'s `book` are the same field.
   */
  subjectLabel: string;
  /**
   * The reviewer's reason, where one was given. Dropped before the write for a
   * kind whose `isReviewNoteDelivered` is false.
   *
   * REVIEWER-authored prose written TO this recipient, never member-authored
   * content, and never anything a third party wrote. Anything arriving here
   * with markup in it is a bug at the write boundary that produced it, not
   * something for this method to launder.
   */
  reviewNote?: string | null;
  /**
   * The slug the deep link needs, for a kind whose `deepLinkSource` is not
   * `null`. Ignored (and never written) when the kind has no deep link, so a
   * caller cannot smuggle a slug onto a row that has nowhere to point.
   */
  deepLinkSlug?: string | null;
}

/**
 * The one place a "your submission was decided" notification is written
 * (PRD-48).
 *
 * WHY THIS EXISTS AS A SERVICE rather than three calls to
 * `NotificationsService.create`. Three call sites means three chances to forget
 * the best-effort guard, three payload shapes for the client to learn, and
 * three places where the fourth intake's author has nothing to copy. One
 * service means the emit is a single call, the payload is uniform, and adding a
 * kind is a decision the compiler forces (see `SUBMISSION_KIND_NOTIFICATION`).
 *
 * BEST EFFORT, ALWAYS. A notification failure must never fail the decision that
 * produced it. An admin who declines an application and gets a 500 because the
 * bell was momentarily unavailable would reasonably try again, and the second
 * attempt lands on an already-decided row. Errors are logged and swallowed,
 * matching `SafeSpaceNotifierService.tell`, `DirectoryService.addReview` and
 * every other emit site in this repo. CALL IT AFTER THE DECISION HAS COMMITTED,
 * for the same reason those do.
 *
 * NO ACTOR, EVER. `NotificationType.SubmissionDecided` is the platform
 * reporting on the member's own submission, so the bell never names who
 * decided and a block between the submitter and whoever was on the rota can
 * never swallow the answer. This method takes no actor argument at all, which
 * is the enforcement: there is nothing to pass.
 *
 * QueerPulse sends no email and never will. This in-app row (which the push
 * listener may turn into a phone push) IS how a submitter hears back, which is
 * why no copy for it may say anything is on its way.
 */
@Injectable()
export class SubmissionDecisionNotifier {
  private readonly logger = new Logger(SubmissionDecisionNotifier.name);

  constructor(private readonly notifications: NotificationsService) {}

  /**
   * Tell `recipientId` that their submission reached a terminal outcome.
   * Writes exactly one `SubmissionDecided` row. Never throws.
   */
  async notifyDecided(notice: SubmissionDecisionNotice): Promise<void> {
    const { recipientId, kind, outcome } = notice;
    if (!recipientId) return;
    const config = SUBMISSION_KIND_NOTIFICATION[kind];
    // A `kind` outside the enum can only arrive from an untyped boundary, and
    // writing a row the frontend has no copy for would render as generic
    // fallback text. Better to log it and write nothing than to tell a member
    // something happened to something unnamed.
    if (!config) {
      this.logger.warn(
        `No submission notification config for kind "${String(kind)}"; nothing written.`,
      );
      return;
    }

    const subjectLabel = truncate(
      notice.subjectLabel,
      MAX_SUBJECT_LABEL_LENGTH,
    );
    const reviewNote = config.isReviewNoteDelivered
      ? truncate(notice.reviewNote, MAX_REVIEW_NOTE_LENGTH)
      : '';
    const deepLinkSlug = config.deepLinkSource
      ? truncate(notice.deepLinkSlug, MAX_SUBJECT_LABEL_LENGTH)
      : '';

    try {
      await this.notifications.create(
        recipientId,
        NotificationType.SubmissionDecided,
        {
          kind,
          outcome,
          // Written only when there is something to say, so the client's
          // defensive token resolution sees a missing field rather than an empty
          // string it would interpolate as a gap in the sentence.
          ...(subjectLabel ? { subjectLabel } : {}),
          ...(reviewNote ? { reviewNote } : {}),
          ...(config.deepLinkSource ? { source: config.deepLinkSource } : {}),
          ...(deepLinkSlug ? { listingSlug: deepLinkSlug } : {}),
        },
      );
    } catch (error) {
      // Intentionally swallowed: the decision this follows has already
      // committed, and re-running it is worse than a missing bell row.
      this.logger.warn(
        `Failed to notify ${recipientId} of a ${kind} decision: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/** Trim, and cap at `limit`. Returns `''` for anything absent or blank, which
 *  is what the caller above tests before putting a key on the payload. */
function truncate(value: string | null | undefined, limit: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed;
}
