import { MemberRef } from '../common/member-ref';
import { MemberVerification } from './entities/member-verification.entity';
import { VerificationEvent } from './entities/verification-event.entity';
import { VerificationRequest } from './entities/verification-request.entity';
import {
  VerificationEventAction,
  VerificationLevel,
  VerificationType,
} from './verification-level';
import { VerificationRequestStatus } from './verification-request-status';

/** The member's own verification standing (what the step-up UI reads). */
export interface VerificationStatusDTO {
  level: VerificationLevel;
  /** Convenience booleans so the client never re-derives the ladder. */
  phoneVerified: boolean;
  idVerified: boolean;
  method: string | null;
  provider: string | null;
  verifiedAt: string | null;
}

export function toVerificationStatusDTO(
  level: VerificationLevel,
  row: MemberVerification | null,
): VerificationStatusDTO {
  return {
    level,
    phoneVerified:
      level === VerificationLevel.Phone ||
      level === VerificationLevel.IdVerified,
    idVerified: level === VerificationLevel.IdVerified,
    method: row?.method ?? null,
    provider: row?.provider ?? null,
    verifiedAt: row?.verifiedAt?.toISOString() ?? null,
  };
}

/** Admin-facing row for the manual-review console. Carries the member ref and
 * the opaque provider ref (never any document data — there is none to carry). */
export interface AdminVerificationDTO {
  userId: string;
  member: MemberRef | null;
  level: VerificationLevel;
  method: string | null;
  provider: string | null;
  providerRef: string | null;
  verifiedAt: string | null;
  updatedAt: string;
}

export function toAdminVerificationDTO(
  row: MemberVerification,
  member: MemberRef | null,
): AdminVerificationDTO {
  return {
    userId: row.userId,
    member,
    level: row.level,
    method: row.method,
    provider: row.provider,
    providerRef: row.providerRef,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** One row of a member's append-only audit trail, for the admin drawer's
 * history panel. `actor` is the moderator/admin who performed the action —
 * `null` for a system-attributed or not-yet-attributed event (nothing in
 * Phase 1 writes those, but the shape stays honest either way). */
export interface VerificationEventDTO {
  id: string;
  action: VerificationEventAction;
  fromLevel: VerificationLevel | null;
  toLevel: VerificationLevel | null;
  reason: string | null;
  actor: MemberRef | null;
  createdAt: string;
}

export function toVerificationEventDTO(
  event: VerificationEvent,
  actor: MemberRef | null,
): VerificationEventDTO {
  return {
    id: event.id,
    action: event.action,
    fromLevel: event.fromLevel,
    toLevel: event.toLevel,
    reason: event.reason,
    actor,
    createdAt: event.createdAt.toISOString(),
  };
}

/** Sort orders the admin list accepts. `recent`/`oldest` order by
 * `updated_at`; `level` orders by the verification-ladder rank (see
 * `levelRank`), highest assurance first. */
export const ADMIN_VERIFICATION_SORTS = ['recent', 'oldest', 'level'] as const;
export type AdminVerificationSort = (typeof ADMIN_VERIFICATION_SORTS)[number];

/** `GET /admin/verifications` response — a page of rows, the per-level tab
 * counts (unaffected by the active `level` filter, so every tab can show its
 * own count regardless of which one is selected), and an opaque keyset
 * cursor for "load more". */
export interface AdminVerificationListDTO {
  rows: AdminVerificationDTO[];
  counts: Record<VerificationLevel, number>;
  nextCursor: string | null;
}

// --- request lifecycle DTOs (Tasks 4 + 5) ---

/**
 * A member's own view of one of their verification requests — the shape
 * `POST /verification/requests`, `.../withdraw`, `.../appeal`, and
 * `GET /verification/me`'s `latestRequest` all return. Hand-mapped and
 * deliberately narrow: no `reviewedByUserId`, no `signals` (reviewer-only —
 * see `AdminVerificationRequestDetailDTO`), and no `evidenceRef` (the member
 * already knows what they submitted; it isn't echoed back here).
 */
export interface VerificationRequestDTO {
  id: string;
  type: VerificationType;
  requestedLevel: VerificationLevel;
  status: VerificationRequestStatus;
  context: string | null;
  decisionReason: string | null;
  isAppeal: boolean;
  createdAt: string;
  updatedAt: string;
}

export function toVerificationRequestDTO(
  row: VerificationRequest,
): VerificationRequestDTO {
  return {
    id: row.id,
    type: row.type,
    requestedLevel: row.requestedLevel,
    status: row.status,
    context: row.context,
    decisionReason: row.decisionReason,
    isAppeal: row.isAppeal,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** `GET /verification/me` response — the member's current standing (Phase 1
 * shape, unchanged) plus their newest request for the default type, so the
 * client can render submitted/in-review/approved/rejected/appealing status
 * without a second round trip. `null` when the member has never submitted
 * one. */
export interface VerificationStatusWithRequestDTO extends VerificationStatusDTO {
  latestRequest: VerificationRequestDTO | null;
}

/** Sort orders the admin request queue accepts, both by `created_at` (the
 * submission date — the field a triage queue cares about, unlike the level
 * console's `updated_at`). */
export const VERIFICATION_REQUEST_SORTS = ['recent', 'oldest'] as const;
export type VerificationRequestSort =
  (typeof VERIFICATION_REQUEST_SORTS)[number];

/** Admin request-queue row — `GET /admin/verifications/requests`'s list
 * item. Carries the member ref but none of the reviewer-only detail
 * (`context`/`signals`/`decisionReason`/history) — that's the detail DTO
 * below, mirroring the level console's list/detail split. The one exception
 * is `hasDuplicateSignal`: a light boolean derived from the row's own
 * `signals` snapshot (never the full `VerificationSignalsDTO`) so the queue
 * can flag a duplicate at a glance without a reviewer opening the drawer. */
export interface AdminVerificationRequestDTO {
  id: string;
  member: MemberRef | null;
  type: VerificationType;
  requestedLevel: VerificationLevel;
  status: VerificationRequestStatus;
  isAppeal: boolean;
  createdAt: string;
  updatedAt: string;
  /** `true` when this request's snapshotted `signals.duplicateProviderRef`
   * is set — the member's identity-provider session reference is shared
   * with at least one other account. Read off the already-loaded `signals`
   * jsonb column (`listRequestsForAdmin`'s query carries the whole row, no
   * `.select()` narrowing it), so this never costs a second query. */
  hasDuplicateSignal: boolean;
  /**
   * OPS-04. The reviewer currently working this request, or null when nobody
   * has claimed it. Distinct from `reviewedBy` on the detail DTO, which is who
   * DECIDED it: a claim says "I have this open" so a second reviewer does not
   * duplicate the work, and it is given back by releasing.
   */
  assignedStaffId: string | null;
  /** Only present when `assignedStaffId` is set. "Deleted member" after that
   *  reviewer's erasure (see `queueAssigneeName`). */
  assignedStaffName?: string;
  /**
   * ISO 8601. When this request should have been decided by, stamped from
   * `verification-sla.ts` at submission and restarted on the shorter appeal
   * window when the member appeals. NULL means NO CLOCK, never overdue:
   * requests decided before OPS-04 existed carry none.
   */
  dueAt: string | null;
}

export function toAdminVerificationRequestDTO(
  row: VerificationRequest,
  member: MemberRef | null,
  // Resolved by the caller through `optionalQueueAssigneeName` against a
  // batched profile lookup, so a page costs no extra query per row.
  assignedStaffName?: string,
): AdminVerificationRequestDTO {
  return {
    id: row.id,
    member,
    type: row.type,
    requestedLevel: row.requestedLevel,
    status: row.status,
    isAppeal: row.isAppeal,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    // Same cast this file's `toAdminVerificationRequestDetailDTO` already
    // makes for the same column: the generic entity shape is
    // `Record<string, unknown> | null`, and every writer of it
    // (`computeSignals`) always shapes it as `VerificationSignalsDTO`.
    hasDuplicateSignal: Boolean(
      (row.signals as VerificationSignalsDTO | null)?.duplicateProviderRef,
    ),
    assignedStaffId: row.assignedStaffId,
    ...(assignedStaffName ? { assignedStaffName } : {}),
    dueAt: row.dueAt ? row.dueAt.toISOString() : null,
  };
}

/**
 * Anti-fraud signals snapshotted onto a request's `signals` jsonb column at
 * submit time and refreshed at decision time (`VerificationService.
 * computeSignals`) — the evidence a reviewer sees alongside the request.
 *
 * DEFERRED (computed nowhere yet): phone/VOIP-carrier and IP/geo signals.
 * This platform never stores a member's phone number at all (the automated
 * phone-OTP step-up was removed; `phone` level is now granted only through
 * manual review) and captures no IP/geo data anywhere, so there is nothing
 * server-side to compute those from today. `duplicateProviderRef` (the
 * member's identity-provider session reference shared with another account)
 * is the only cross-account signal available.
 */
export interface VerificationSignalsDTO {
  /** Whole days since the member's account (`users.created_at`) was created. */
  accountAgeDays: number;
  /** Count of this member's own PAST `verification_requests` rows decided
   * `rejected` (never includes the request currently being decided). */
  priorRejections: number;
  /** Non-null only when the member's current `member_verifications.
   * provider_ref` is shared by at least one OTHER account — a batched
   * grouped query, never a null/unique ref. */
  duplicateProviderRef: { count: number; userIds: string[] } | null;
}

/** `GET /admin/verifications/requests/:id` response — the list row's fields
 * plus everything a reviewer needs to decide: the member's own context and
 * evidence reference, the prior decision (if any) and who reviewed it, the
 * anti-fraud `signals` snapshot, and the member's full verification audit
 * trail (not just this request's events — `listHistoryDTO` covers every
 * change to the member's standing, requests and overrides alike). */
export interface AdminVerificationRequestDetailDTO extends AdminVerificationRequestDTO {
  context: string | null;
  evidenceRef: string | null;
  decisionReason: string | null;
  reviewedBy: MemberRef | null;
  signals: VerificationSignalsDTO | null;
  history: VerificationEventDTO[];
}

export function toAdminVerificationRequestDetailDTO(
  row: VerificationRequest,
  member: MemberRef | null,
  reviewedBy: MemberRef | null,
  history: VerificationEventDTO[],
  assignedStaffName?: string,
): AdminVerificationRequestDetailDTO {
  return {
    ...toAdminVerificationRequestDTO(row, member, assignedStaffName),
    context: row.context,
    evidenceRef: row.evidenceRef,
    decisionReason: row.decisionReason,
    reviewedBy,
    // The entity column is the generic `Record<string, unknown> | null`
    // jsonb shape (no entity -> DTO coupling); every writer of this column
    // (`computeSignals`, via `submitRequest`/`decideRequest`) always shapes
    // it as `VerificationSignalsDTO`, so this cast is safe.
    signals: row.signals as VerificationSignalsDTO | null,
    history,
  };
}

/** `GET /admin/verifications/requests` response — a page of rows, the
 * per-status tab counts (zero-filled over every `VerificationRequestStatus`,
 * unaffected by the active `status` filter so every tab shows its own count
 * — mirrors `AdminVerificationListDTO.counts`), and an opaque keyset cursor
 * for "load more". */
export interface AdminVerificationRequestListDTO {
  rows: AdminVerificationRequestDTO[];
  counts: Record<VerificationRequestStatus, number>;
  nextCursor: string | null;
}
