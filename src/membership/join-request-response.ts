import {
  PlatformJoinRequest,
  PlatformJoinRequestStatus,
} from './entities/join-request.entity';
import { JoinRequestFlag } from './join-request-flags';

/**
 * The admin-queue view of a join request. Mapped explicitly (never the raw
 * entity) so the wire shape is a decision rather than a side effect of the
 * schema — same idiom as `invite-response.ts`.
 *
 * `inviteCode` is a CODE, never a URL: the backend has no business assuming the
 * frontend's origin or route map (`app.frontendUrl` is an allowlist that can
 * legitimately hold apex + www + staging). Approval also fires an automatic
 * invite email (`JoinRequestsService.review` → `join_request_approved`
 * template); the frontend still builds the link from this code too, as a
 * manual backup a reviewer can send by hand if the email doesn't land.
 */
export interface JoinRequestView {
  id: string;
  name: string;
  email: string;
  city: string | null;
  message: string;
  mutualMemberEmail: string | null;
  source: string | null;
  status: PlatformJoinRequestStatus;
  ageAttestedAt: Date;
  termsVersion: string;
  createdAt: Date;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  declineReason: string | null;
  inviteCode: string | null;
  /**
   * Confidence-tiered triage signals computed at read time from the current
   * fetched batch (see `computeBatchFlags`) — never persisted, never used to
   * auto-accept/reject. Empty for a single just-reviewed row returned by
   * `review()`, since a lone row has no batch context to compare against.
   */
  flags: JoinRequestFlag[];
  /**
   * How many DECLINED requests exist for this email across all history, not
   * just a boolean "was this ever declined" — richer context for a reviewer
   * seeing a returning applicant. 0 for a single just-reviewed row returned
   * by `review()` (a request's own history is irrelevant to displaying
   * itself right after a decision).
   */
  priorDeclineCount: number;
  /**
   * Display name/slug of the member `mutualMemberEmail` resolved to at
   * submit time (see `PlatformJoinRequest.referenceUserId`), so a reviewer
   * gets a real profile link instead of trusting an unverified string. Both
   * null when there was no reference, or it didn't match an active member.
   * Null for a single just-reviewed row returned by `review()` (no batch
   * context to resolve against).
   */
  referenceMemberName: string | null;
  referenceMemberSlug: string | null;
}

/**
 * The 201 body of the public `POST /join-requests`. Deliberately narrow: the
 * submitter is unauthenticated, so echoing back the stored row would let anyone
 * confirm what the queue holds.
 */
export interface SubmittedJoinRequestView {
  id: string;
  status: PlatformJoinRequestStatus;
  createdAt: Date;
}

export function toJoinRequestView(
  request: PlatformJoinRequest,
  inviteCode: string | null,
  flags: JoinRequestFlag[] = [],
  priorDeclineCount = 0,
  referenceMemberName: string | null = null,
  referenceMemberSlug: string | null = null,
): JoinRequestView {
  return {
    id: request.id,
    name: request.name,
    email: request.email,
    city: request.city,
    message: request.message,
    mutualMemberEmail: request.mutualMemberEmail,
    source: request.source,
    status: request.status,
    ageAttestedAt: request.ageAttestedAt,
    termsVersion: request.termsVersion,
    createdAt: request.createdAt,
    reviewedAt: request.reviewedAt,
    reviewedBy: request.reviewedBy,
    declineReason: request.declineReason,
    inviteCode,
    flags,
    priorDeclineCount,
    referenceMemberName,
    referenceMemberSlug,
  };
}

export function toSubmittedJoinRequestView(
  request: PlatformJoinRequest,
): SubmittedJoinRequestView {
  return {
    id: request.id,
    status: request.status,
    createdAt: request.createdAt,
  };
}
