import { IdentityRelinkCandidate } from '../auth/entities/identity-relink-candidate.entity';

/**
 * Hand-mapped response shapes for the three identity-recovery levers. There is
 * no global serializer in this repo, so every one of these exists to stop a
 * raw entity reaching the wire.
 *
 * The one that matters most is {@link RelinkCandidateDTO}: its source row
 * carries a Google subject id, and this mapper is the reason the admin console
 * never receives one in full.
 */

/**
 * How much of a Google subject id the admin console is allowed to see.
 *
 * An operator needs to tell two candidates apart and to recognise the same
 * candidate across a page reload. Six characters does both. The full subject is
 * a stable cross-service identifier for a real person's Google account, it is
 * useless to the operator (there is no field to paste it into: the lever is
 * driven by `candidateId`), and `mod_audit_logs` is readable by every
 * moderator, so publishing it would spread third-party identity PII across a
 * surface that has no use for it.
 */
const GOOGLE_ID_TAIL_LENGTH = 6;

/** The last few characters of a Google subject, for telling candidates apart.
 *  Never the whole value: see {@link GOOGLE_ID_TAIL_LENGTH}. */
export function googleIdTail(googleId: string): string {
  return googleId.slice(-GOOGLE_ID_TAIL_LENGTH);
}

/**
 * One Google identity waiting to be accepted or refused as this member's new
 * sign-in (PRD-06).
 *
 * `attemptCount` and `firstSeenAt`/`lastSeenAt` are the operator's evidence.
 * A genuine re-created account looks like a handful of attempts clustered in
 * time from one subject; several distinct subjects on one address looks like
 * something else entirely and should be dismissed.
 */
export interface RelinkCandidateDTO {
  id: string;
  /** The LAST SIX characters of the Google subject, never the whole value. */
  googleIdTail: string;
  status: 'pending' | 'applied' | 'dismissed' | 'superseded';
  attemptCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
}

/**
 * One lever's availability, plus the sentence to show when it is closed.
 *
 * `blockedReason` is written for the OPERATOR to read and the console renders
 * it verbatim, so a refused lever explains itself instead of presenting a dead
 * button. It is the difference between a locked-out moderator's case reading as
 * "demote them first, then re-link" and reading as "this feature is broken".
 * The strings are built server-side because the server is the only place that
 * knows which of several refusals applies, and mirroring that decision into the
 * client would be a second copy of the guardrails that can drift out of step
 * with the one that is enforced.
 */
export interface RecoveryLeverDTO {
  isAvailable: boolean;
  blockedReason: string | null;
}

/**
 * Everything the member console's account-recovery panel needs, in one read.
 *
 * Both levers travel together because an operator looking at a locked-out
 * member does not yet know which of the two situations they are in, and
 * `reactivation.isApplicable` is the only way the console can learn that this
 * member is deactivated at all: the member detail DTO carries no account
 * status, and widening it would put a status field on every roster row for the
 * sake of one panel.
 */
export interface MemberAccountRecoveryDTO {
  memberId: string;
  slug: string;
  relink: RecoveryLeverDTO & { candidates: RelinkCandidateDTO[] };
  /** `isApplicable` is "this member is deactivated at all". A member who is
   *  active gets the whole section hidden rather than a refusal. */
  reactivation: RecoveryLeverDTO & { isApplicable: boolean };
}

/** The outcome of applying or dismissing a candidate, so the console can patch
 *  the panel without a second read. */
export interface RelinkDecisionDTO {
  memberId: string;
  candidateId: string;
  status: 'applied' | 'dismissed';
  decidedAt: string;
}

/** The outcome of reactivating a stranded member (PRD-11). */
export interface ReactivatedMemberDTO {
  memberId: string;
  slug: string;
  status: string;
  reactivatedAt: string;
}

/**
 * What the suppression list holds for one address (PRD-13).
 *
 * `emailHashPrefix` is the identifier an operator quotes in a ticket. The
 * address itself is echoed back exactly as normalized so they can see the
 * lookup matched what they meant to type, and nothing about the erased account
 * is included, because nothing about it survives: the row is a hash and a date.
 */
export interface EmailSuppressionLookupDTO {
  email: string;
  isSuppressed: boolean;
  emailHashPrefix: string;
  reason: string | null;
  suppressedAt: string | null;
}

/** The outcome of lifting a suppression. `isSuppressed` is always false here:
 *  a lift that changed nothing answers 404 rather than reporting success. */
export interface EmailSuppressionLiftedDTO {
  email: string;
  isSuppressed: false;
  emailHashPrefix: string;
  liftedAt: string;
}

export function toRelinkCandidate(
  candidate: IdentityRelinkCandidate,
): RelinkCandidateDTO {
  return {
    id: candidate.id,
    googleIdTail: googleIdTail(candidate.googleId),
    status: candidate.status,
    attemptCount: candidate.attemptCount,
    firstSeenAt: candidate.createdAt.toISOString(),
    lastSeenAt: candidate.lastSeenAt.toISOString(),
    decidedAt: candidate.decidedAt ? candidate.decidedAt.toISOString() : null,
    decisionNote: candidate.decisionNote,
  };
}
