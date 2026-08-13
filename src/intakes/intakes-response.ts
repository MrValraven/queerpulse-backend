import { IntakeSubmission } from './entities/intake-submission.entity';
import type { MemberRef } from '../common/member-ref';
import type { IntakeKind, IntakeStatus } from './intake-kinds';

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
}

export function toIntakeSubmissionDTO(
  submission: IntakeSubmission,
  submitter: MemberRef | null = null,
): IntakeSubmissionDTO {
  return {
    id: submission.id,
    kind: submission.kind,
    submitterId: submission.submitterId,
    submitter: toIntakeSubmitterDTO(submitter),
    payload: submission.payload,
    status: submission.status,
    createdAt: submission.createdAt.toISOString(),
  };
}

export function toIntakeAckDTO(submission: IntakeSubmission): IntakeAckDTO {
  return { id: submission.id, status: submission.status };
}
