import { JoinRequest, JoinRequestStatus } from './entities/join-request.entity';

/**
 * The admin-queue view of a join request. Mapped explicitly (never the raw
 * entity) so the wire shape is a decision rather than a side effect of the
 * schema — same idiom as `invite-response.ts`.
 *
 * `inviteCode` is a CODE, never a URL: the backend has no business assuming the
 * frontend's origin or route map (`app.frontendUrl` is an allowlist that can
 * legitimately hold apex + www + staging). The admin copies the link the
 * frontend builds and sends it themselves — there is no email service.
 */
export interface JoinRequestView {
  id: string;
  name: string;
  email: string;
  city: string | null;
  message: string;
  status: JoinRequestStatus;
  ageAttestedAt: Date;
  termsVersion: string;
  createdAt: Date;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  inviteCode: string | null;
}

/**
 * The 201 body of the public `POST /join-requests`. Deliberately narrow: the
 * submitter is unauthenticated, so echoing back the stored row would let anyone
 * confirm what the queue holds.
 */
export interface SubmittedJoinRequestView {
  id: string;
  status: JoinRequestStatus;
  createdAt: Date;
}

export function toJoinRequestView(
  request: JoinRequest,
  inviteCode: string | null,
): JoinRequestView {
  return {
    id: request.id,
    name: request.name,
    email: request.email,
    city: request.city,
    message: request.message,
    status: request.status,
    ageAttestedAt: request.ageAttestedAt,
    termsVersion: request.termsVersion,
    createdAt: request.createdAt,
    reviewedAt: request.reviewedAt,
    reviewedBy: request.reviewedBy,
    inviteCode,
  };
}

export function toSubmittedJoinRequestView(
  request: JoinRequest,
): SubmittedJoinRequestView {
  return {
    id: request.id,
    status: request.status,
    createdAt: request.createdAt,
  };
}
