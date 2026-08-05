import { IntakeSubmission } from './entities/intake-submission.entity';
import type { IntakeKind, IntakeStatus } from './intake-kinds';

/**
 * Full wire shape for an intake submission, hand-mapped from the entity so a
 * column added later can't leak. Returned only by the admin triage list.
 */
export interface IntakeSubmissionDTO {
  id: string;
  kind: IntakeKind;
  submitterId: string | null;
  payload: Record<string, unknown>;
  status: IntakeStatus;
  /** ISO 8601 timestamp. */
  createdAt: string;
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
): IntakeSubmissionDTO {
  return {
    id: submission.id,
    kind: submission.kind,
    submitterId: submission.submitterId,
    payload: submission.payload,
    status: submission.status,
    createdAt: submission.createdAt.toISOString(),
  };
}

export function toIntakeAckDTO(submission: IntakeSubmission): IntakeAckDTO {
  return { id: submission.id, status: submission.status };
}
