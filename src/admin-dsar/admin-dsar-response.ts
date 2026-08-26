import {
  DsarRequest,
  DsarStatus,
} from '../account/entities/dsar-request.entity';
import { MemberRef } from '../common/member-ref';

/** One day in milliseconds, for the statutory countdown below. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Display-ready reference to the member who filed a DSAR. Carries a single
 * composed `name` (never raw first/last), mirroring `AdminInvitePersonDTO` in
 * `admin-invites-response.ts`, so the admin queue can render it directly.
 */
export interface AdminDsarMemberDTO {
  slug: string;
  name: string;
  avatarUrl: string | null;
}

/** Compose the display shape the admin UI expects from a resolved `MemberRef`. */
export function toAdminDsarMember(
  ref: MemberRef | null,
): AdminDsarMemberDTO | null {
  if (!ref) return null;
  return {
    slug: ref.slug,
    name: `${ref.firstName} ${ref.lastName}`.trim(),
    avatarUrl: ref.avatarUrl,
  };
}

/** A DSAR is still running its statutory clock while it sits in one of these. */
export function isOpenDsarStatus(status: DsarStatus): boolean {
  return status === DsarStatus.Received || status === DsarStatus.InReview;
}

/**
 * Whole days from `now` to the statutory deadline, rounded UP so a deadline
 * later today reads as 1 day rather than 0. Negative once the deadline has
 * passed, which is exactly what the overdue read-out shows.
 */
export function daysRemainingUntil(dueBy: Date, now: Date): number {
  return Math.ceil((dueBy.getTime() - now.getTime()) / DAY_MS);
}

/**
 * One DSAR on the admin queue (`GET /admin/dsar`). Hand-mapped from the entity
 * with no raw columns leaking. It carries more than the member-facing `DsarResponse`
 * (`account-response.ts`) by design: the internal `id` the PATCH is addressed
 * by, the requester's identity, the free text they wrote, and the operator's
 * outcome note. `resolvedByUserId` is deliberately NOT exposed, matching
 * `AdminCommunityTagRequestDTO`'s omission of its own decider column.
 */
export interface AdminDsarRequestDTO {
  id: string;
  reference: string;
  article: number;
  status: DsarStatus;
  scopes: string[];
  details: string;
  context: string | null;
  member: AdminDsarMemberDTO | null;
  submittedAt: string;
  dueBy: string;
  respondedAt: string | null;
  outcomeNote: string | null;
  /** Whole days left before the statutory deadline; negative once it passed. */
  daysRemaining: number;
  /** True only while the request is still open AND past its deadline. A
   *  request answered late is no longer accruing, so it reads as closed. */
  isOverdue: boolean;
}

export interface AdminDsarPageDTO {
  items: AdminDsarRequestDTO[];
  total: number;
  page: number;
  pageSize: number;
}

export function toAdminDsarRequestDTO(
  request: DsarRequest,
  member: MemberRef | null,
  now: Date,
): AdminDsarRequestDTO {
  const daysRemaining = daysRemainingUntil(request.dueBy, now);
  return {
    id: request.id,
    reference: request.reference,
    article: request.article,
    status: request.status,
    scopes: request.scopes ?? [],
    details: request.details,
    context: request.context,
    member: toAdminDsarMember(member),
    submittedAt: request.submittedAt.toISOString(),
    dueBy: request.dueBy.toISOString(),
    respondedAt: request.respondedAt ? request.respondedAt.toISOString() : null,
    outcomeNote: request.outcomeNote,
    daysRemaining,
    isOverdue: isOpenDsarStatus(request.status) && daysRemaining < 0,
  };
}
