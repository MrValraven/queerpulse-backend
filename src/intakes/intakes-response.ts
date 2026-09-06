import { IntakeSubmission } from './entities/intake-submission.entity';
import type { MemberRef } from '../common/member-ref';
import type { IntakeKind, IntakeStatus } from './intake-kinds';

/**
 * The admin who triaged a submission, reduced to what the console renders: an
 * id (to compare against "is that me?") and a display name. Deliberately
 * narrower than {@link IntakeSubmitterDTO} — a staff triage stamp is not a
 * member card, so no slug and no avatar. Mirrors `InquiryHandlerDTO`, so the
 * console reads one shape across both inboxes.
 */
export interface IntakeReviewerDTO {
  id: string;
  name: string;
}

/**
 * A signed-in submitter resolved to display fields for the admin dashboard, so
 * staff see a name/avatar rather than a bare uuid. `null` when the submission
 * was anonymous (logged-out) or the member's profile is gone.
 */
export interface IntakeSubmitterDTO {
  slug: string;
  name: string;
  avatarUrl: string | null;
}

/**
 * Full wire shape for an intake submission, hand-mapped from the entity so a
 * column added later can't leak. Returned only by the admin triage list.
 */
export interface IntakeSubmissionDTO {
  id: string;
  kind: IntakeKind;
  submitterId: string | null;
  /** The signed-in submitter's display fields, resolved in a batched profile
   *  lookup by the service; `null` when anonymous. */
  submitter: IntakeSubmitterDTO | null;
  payload: Record<string, unknown>;
  status: IntakeStatus;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** ISO 8601 timestamp of the last move out of `new`; null while untouched. */
  reviewedAt: string | null;
  /**
   * The admin who last moved it out of `new`; null while untouched, and also
   * null for a row triaged before this provenance existed (no attribution is
   * invented — see the migration).
   */
  reviewedBy: IntakeReviewerDTO | null;
  /**
   * OPS-04. The staff member currently working this submission, or null when
   * nobody has claimed it. Distinct from `reviewedBy`, which is who last MOVED
   * it: a claim says "I have this open" so two admins do not work the same
   * pile, and it is given back by releasing.
   */
  assignedStaffId: string | null;
  /** Only present when `assignedStaffId` is set. "Deleted member" after that
   *  reviewer's erasure (see `queueAssigneeName`). */
  assignedStaffName?: string;
  /**
   * ISO 8601. When this submission should have been worked by, stamped at
   * submission from the per-kind windows in `intake-sla.ts`. NULL means NO
   * CLOCK, never overdue: submissions already closed before OPS-04 existed
   * carry none.
   */
  dueAt: string | null;
}

/** Map a resolved member reference to the submitter display shape. */
export function toIntakeSubmitterDTO(
  ref: MemberRef | null,
): IntakeSubmitterDTO | null {
  if (!ref) return null;
  return {
    slug: ref.slug,
    name: `${ref.firstName} ${ref.lastName}`.trim(),
    avatarUrl: ref.avatarUrl,
  };
}

/**
 * Minimal acknowledgement for the public submit — echoes back only the new
 * row's id and triage status, never any of the submitted payload or the
 * submitter's identity.
 */
export interface IntakeAckDTO {
  id: string;
  status: IntakeStatus;
  /**
   * PRD-261. The plaintext reference code for a `governance_concern`, present
   * ONLY in this response and never again: the column holds its sha256 hash
   * and QueerPulse delivers no email, so this field is the entire delivery
   * mechanism. Absent for the eleven other intake kinds, which have no
   * submitter-facing status lookup.
   */
  statusToken?: string;
  /** ISO 8601. When the submission was recorded, so the confirmation screen
   *  and the status page can both date it without a second read. */
  submittedAt: string;
}

/**
 * PRD-261. What a concern submitter is allowed to see with nothing but their
 * reference code: where their own concern stands, and when.
 *
 * DELIBERATELY THREE FIELDS. The code is a bearer credential on a public read,
 * so this shape is the blast radius of a leaked or shoulder-surfed code. It
 * carries no id (nothing to enumerate), no category, no description, no
 * submitter email, no reviewer name and no staff note — none of which the
 * person holding the code needs in order to learn that their concern is being
 * looked at, was resolved, or was closed without action. Everything they wrote
 * is already theirs; everything staff wrote is not theirs to read here.
 */
export interface ConcernStatusDTO {
  status: IntakeStatus;
  /** ISO 8601 — when the concern was submitted. */
  submittedAt: string;
  /** ISO 8601 — when staff last moved it; null while it is still untouched. */
  updatedAt: string | null;
}

export function toConcernStatusDTO(
  submission: IntakeSubmission,
): ConcernStatusDTO {
  return {
    status: submission.status,
    submittedAt: submission.createdAt.toISOString(),
    updatedAt: submission.reviewedAt
      ? submission.reviewedAt.toISOString()
      : null,
  };
}

/** Map a resolved member reference to the compact reviewer shape. */
export function toIntakeReviewerDTO(
  reviewerId: string | null,
  ref: MemberRef | null,
): IntakeReviewerDTO | null {
  if (!reviewerId) return null;
  return {
    id: reviewerId,
    // The account can outlive its profile row (or lose it); the id is what the
    // console actually needs, so a missing profile degrades to a placeholder
    // rather than dropping the attribution entirely.
    name: ref ? `${ref.firstName} ${ref.lastName}`.trim() : 'Staff',
  };
}

export function toIntakeSubmissionDTO(
  submission: IntakeSubmission,
  submitter: MemberRef | null = null,
  reviewer: MemberRef | null = null,
  // OPS-04. Resolved by the caller through `optionalQueueAssigneeName`
  // against the same batched profile lookup the submitter and reviewer use,
  // so a page costs no extra query.
  assignedStaffName?: string,
): IntakeSubmissionDTO {
  return {
    id: submission.id,
    kind: submission.kind,
    submitterId: submission.submitterId,
    submitter: toIntakeSubmitterDTO(submitter),
    payload: submission.payload,
    status: submission.status,
    createdAt: submission.createdAt.toISOString(),
    reviewedAt: submission.reviewedAt
      ? submission.reviewedAt.toISOString()
      : null,
    reviewedBy: toIntakeReviewerDTO(submission.reviewedById, reviewer),
    assignedStaffId: submission.assignedStaffId,
    ...(assignedStaffName ? { assignedStaffName } : {}),
    dueAt: submission.dueAt ? submission.dueAt.toISOString() : null,
  };
}

/**
 * `statusToken` is passed in rather than read off the row, because the row
 * only ever holds its hash. Undefined for every kind that mints no code.
 */
export function toIntakeAckDTO(
  submission: IntakeSubmission,
  statusToken?: string,
): IntakeAckDTO {
  return {
    id: submission.id,
    status: submission.status,
    ...(statusToken ? { statusToken } : {}),
    submittedAt: submission.createdAt.toISOString(),
  };
}
