import {
  PlatformJoinRequest,
  PlatformJoinRequestStatus,
} from './entities/join-request.entity';
import { PublicInviteStatus } from './invite-response';
import { JoinRequestFlag } from './join-request-flags';

/**
 * The approval-minted invite as the review queue needs to see it: the code to
 * hand over, plus the two things that decide whether handing it over is still
 * worth anything. Resolved by the caller through `resolveInviteStatus`, the
 * same lazily-computed status the invite landing page and the member's own
 * invite list read, so a lapsed-but-unswept row never reports itself valid.
 */
export interface JoinRequestInviteRef {
  code: string;
  status: PublicInviteStatus;
  expiresAt: Date | null;
}

/**
 * The admin-queue view of a join request. Mapped explicitly (never the raw
 * entity) so the wire shape is a decision rather than a side effect of the
 * schema — same idiom as `invite-response.ts`.
 *
 * `inviteCode` is a CODE, never a URL: the backend has no business assuming the
 * frontend's origin or route map (`app.frontendUrl` is an allowlist that can
 * legitimately hold apex + www + staging). The frontend builds the link from
 * this code, and a reviewer sends it to the applicant by hand: approval
 * delivers nothing to their inbox, because the platform runs no mail service
 * for applicants, so this code is the only route an invite has to them.
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
  /**
   * Display name of the reviewer in `reviewedBy`, resolved through the same
   * batched `queueAssigneeName` path `assignedStaffName` uses. The id stays
   * beside it because the id is the stable thing: a display name changes when
   * someone renames themselves, and the quality-sample surface groups a
   * reviewer's decisions on the id.
   *
   * Absent when `reviewedBy` is null. That covers erasure too, and correctly:
   * `join_requests.reviewed_by` is `ON DELETE SET NULL`, so an erased
   * reviewer's id is already gone from the row and there is no name left to
   * resolve, and nothing here can resurrect one. Also absent on a single row
   * mapped without a batch to resolve against (`review()`).
   */
  reviewedByName?: string;
  declineReason: string | null;
  /**
   * OPS-04. The reviewer currently working this request, or null when nobody
   * has claimed it. Distinct from `reviewedBy`, which is who DECIDED it: a
   * claim says "I am looking at this now" so a second reviewer does not open
   * the same applicant, and it is released again if they walk away.
   */
  assignedStaffId: string | null;
  /** Only set when `assignedStaffId` is. "Deleted member" after that
   *  reviewer's erasure (see `queueAssigneeName`). */
  assignedStaffName?: string;
  /**
   * When this request should have been answered by, stamped at submission from
   * `JOIN_REQUEST_REVIEW_WINDOW_MS`. NULL means NO CLOCK, never overdue:
   * requests decided before OPS-04 existed carry none, and the queue reads a
   * null as nothing to say.
   */
  dueAt: Date | null;
  inviteCode: string | null;
  /**
   * Lifecycle of the approval-minted invite, computed at read time. Null when
   * no invite was minted (a pending, waitlisted or declined request). Without
   * it the queue can print a link it has no way of knowing is already dead:
   * approval invites lapse after 7 days, and nothing else on this view says so.
   */
  inviteStatus: PublicInviteStatus | null;
  /** ISO-serialisable expiry of that invite, or null when it has none. */
  inviteExpiresAt: Date | null;
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
  /**
   * The PLAINTEXT status token, returned HERE AND NOWHERE ELSE, ever.
   *
   * Only its sha256 hash is stored (`PlatformJoinRequest.statusTokenHash`), so
   * no later request — not the admin queue, not a re-submission, not a support
   * lookup — can reproduce this value. This one response is the whole delivery
   * mechanism, because the platform sends the applicant no email and never
   * will: if the frontend does not show and persist it at submission time, the
   * applicant has permanently lost their only route to
   * `GET /join-requests/status`.
   */
  statusToken: string;
}

/**
 * What an APPLICANT is told about their own request at
 * `GET /join-requests/status?token=…`.
 *
 * `pending` and `waitlisted` deliberately collapse into ONE public value,
 * `under_review`. Waitlisting is an internal triage label the review queue
 * uses to park a request it has not settled; telling an applicant "you were
 * shelved" communicates a decision that has not been made, and a waitlisted
 * request can still be approved. From outside, both states are honestly
 * described by "we are still looking at this", so the public union has three
 * members and the internal enum keeps its four.
 */
export type PublicJoinRequestStatus = 'under_review' | 'approved' | 'declined';

/**
 * The applicant's own view of their request. NARROW on purpose: it carries the
 * outcome and nothing else. No name, no email, no city, no submitted message,
 * no reviewer, no triage flags, no prior-decline count, no id — anyone holding
 * the token can read this, and the token travels in a URL, so it must not be
 * worth stealing for anything beyond "what happened to my request".
 */
export interface PublicJoinRequestStatusView {
  status: PublicJoinRequestStatus;
  /** ISO 8601. When the applicant submitted. */
  submittedAt: string;
  /**
   * ISO 8601, or null while still under review. Null for a WAITLISTED request
   * too, even though the row carries a `reviewedAt`: a decision timestamp
   * beside "under review" would give away that the request had been touched
   * and parked.
   */
  decidedAt: string | null;
  /**
   * The reviewer's closed-set reason key (`spam_pattern`, `underage`,
   * `implausible`, `safety_concern`, `other`, …), present ONLY on a decline.
   * The frontend owns the catalogue that renders it, exactly as the admin
   * queue does.
   */
  declineReason: string | null;
  /**
   * The invite CODE minted by an approval — never a URL, because the backend
   * has no business assuming the frontend's origin or route map (`inviteCode`
   * on `JoinRequestView` makes the same call). Present ONLY when the request
   * was approved AND that invite is still redeemable: null once it has been
   * used, revoked or expired, so the page can say "this invite is no longer
   * valid" instead of offering a dead link. This is what lets an approved
   * applicant recover their own way in without anyone emailing it to them.
   */
  inviteCode: string | null;
  /**
   * PRD-02. WHY the code above is or is not there, so the status page can stop
   * collapsing three different situations into one dead end.
   *
   * `expired` is the recoverable one and the reason this field exists: the
   * applicant can revive it themselves from
   * `POST /join-requests/status/invite/refresh`. `used` means an account was
   * already created with it, and `revoked` is a moderator's deliberate act;
   * neither is refreshable and the page must not offer it. Null when the
   * approval minted no invite, and on every non-approved request.
   *
   * Nothing here is new disclosure: the holder of this token is the applicant,
   * and every value describes only their own invite.
   */
  inviteStatus: PublicInviteStatus | null;
  /**
   * PRD-02. ISO 8601 deadline of the invite above, so the page can say when
   * the link stops working INSTEAD of letting it lapse in silence. Present
   * whenever there is an invite at all, including a lapsed one (where it is
   * the date it lapsed on).
   *
   * Before this, an approved applicant was handed a code with no deadline
   * attached, the sweeper reclaimed it seven days later, and the first thing
   * they learned about the clock was that it had run out.
   */
  inviteExpiresAt: string | null;
}

export function toJoinRequestView(
  request: PlatformJoinRequest,
  invite: JoinRequestInviteRef | null,
  flags: JoinRequestFlag[] = [],
  priorDeclineCount = 0,
  referenceMemberName: string | null = null,
  referenceMemberSlug: string | null = null,
  // OPS-04. Resolved by the caller through `optionalQueueAssigneeName` against
  // a batched profile lookup, so a page of rows costs no extra query per row.
  // Undefined on an unclaimed request, and on a single just-reviewed row where
  // the caller has no batch to resolve against.
  assignedStaffName?: string,
  // The DECIDING reviewer's display name, resolved by the caller through
  // `optionalQueueAssigneeName` against the SAME batched profile lookup the
  // assignee uses, so naming reviewers costs a page no extra query. Undefined
  // when nobody decided the row yet, when the deciding reviewer has since been
  // erased (the id is NULLed by the FK, so there is nothing to resolve), and on
  // a single just-reviewed row with no batch behind it.
  reviewedByName?: string,
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
    ...(reviewedByName ? { reviewedByName } : {}),
    declineReason: request.declineReason,
    assignedStaffId: request.assignedStaffId,
    ...(assignedStaffName ? { assignedStaffName } : {}),
    dueAt: request.dueAt,
    inviteCode: invite?.code ?? null,
    inviteStatus: invite?.status ?? null,
    inviteExpiresAt: invite?.expiresAt ?? null,
    flags,
    priorDeclineCount,
    referenceMemberName,
    referenceMemberSlug,
  };
}

export function toSubmittedJoinRequestView(
  request: PlatformJoinRequest,
  statusToken: string,
): SubmittedJoinRequestView {
  return {
    id: request.id,
    status: request.status,
    createdAt: request.createdAt,
    statusToken,
  };
}

/**
 * Collapses the four internal statuses onto the three an applicant is told
 * about. See `PublicJoinRequestStatus` for why `waitlisted` is not one of
 * them.
 */
export function toPublicJoinRequestStatus(
  status: PlatformJoinRequestStatus,
): PublicJoinRequestStatus {
  switch (status) {
    case PlatformJoinRequestStatus.Approved:
      return 'approved';
    case PlatformJoinRequestStatus.Declined:
      return 'declined';
    case PlatformJoinRequestStatus.Pending:
    case PlatformJoinRequestStatus.Waitlisted:
    default:
      return 'under_review';
  }
}

/**
 * Maps a request onto the applicant-facing status view. The invite is resolved
 * by the caller (it lives on another table and has its own redeemability
 * check) and everything derived from it is dropped unless the request was
 * approved, so a caller mistake cannot leak a code onto a pending row.
 *
 * The CODE is additionally withheld unless the invite currently resolves as
 * `valid`: an expired or revoked code would fail at signup, and offering it
 * would send the applicant to a door that does not open. The `inviteStatus`
 * and `inviteExpiresAt` beside it are still reported, because the whole point
 * of PRD-02 is that the applicant gets to see the clock rather than only its
 * aftermath.
 */
export function toPublicJoinRequestStatusView(
  request: PlatformJoinRequest,
  invite: JoinRequestInviteRef | null,
): PublicJoinRequestStatusView {
  const publicStatus = toPublicJoinRequestStatus(request.status);
  const isDecided = publicStatus === 'approved' || publicStatus === 'declined';
  const approvedInvite = publicStatus === 'approved' ? invite : null;
  return {
    status: publicStatus,
    submittedAt: request.createdAt.toISOString(),
    decidedAt:
      isDecided && request.reviewedAt ? request.reviewedAt.toISOString() : null,
    declineReason:
      publicStatus === 'declined' ? (request.declineReason ?? null) : null,
    inviteCode: approvedInvite?.status === 'valid' ? approvedInvite.code : null,
    inviteStatus: approvedInvite?.status ?? null,
    inviteExpiresAt: approvedInvite?.expiresAt?.toISOString() ?? null,
  };
}
