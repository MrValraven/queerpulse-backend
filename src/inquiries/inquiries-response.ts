import type { MemberRef } from '../common/member-ref';
import type { Paginated } from '../common/pagination';
import { Inquiry } from './entities/inquiry.entity';

/**
 * The admin who took an inquiry off the pile, reduced to what the console
 * renders: an id (to compare against "is that me?") and a display name. No
 * email, no role, no avatar — a staff triage stamp is not a member card, and
 * this is the only place a users row reaches an ops screen.
 */
export interface InquiryHandlerDTO {
  id: string;
  name: string;
}

/**
 * Wire shape for an inquiry. Hand-mapped from the entity — never returned raw —
 * so a column added later can't leak. The public `POST` returns only an
 * acknowledgement id + status; the admin list returns the full row for triage.
 */
export interface InquiryDTO {
  id: string;
  kind: Inquiry['kind'];
  name: string;
  email: string;
  subject?: string;
  body: string;
  orgName?: string;
  status: Inquiry['status'];
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** ISO 8601 timestamp of the move to `handled`; null while `new`. */
  handledAt: string | null;
  /**
   * Who moved it to `handled`; null while `new`, and also null for a row
   * handled before triage provenance existed (no attribution is invented — see
   * the migration).
   */
  handledBy: InquiryHandlerDTO | null;
}

/**
 * `GET /inquiries` — a page of inquiries plus the badge count.
 *
 * `unhandledCount` rides along so the console's "N waiting" badge costs no
 * second request. It reflects the request's `kind` filter but NOT its `status`
 * filter: status is the axis the badge exists to count across, so viewing the
 * handled tab must not zero the badge (same rule as `ListingQueueCounts`).
 */
export interface InquiryListDTO extends Paginated<InquiryDTO> {
  unhandledCount: number;
}

/** Minimal acknowledgement for the public submit — no sender data echoed back. */
export interface InquiryAckDTO {
  id: string;
  status: Inquiry['status'];
}

/** Map a resolved member reference to the compact handler shape. */
export function toInquiryHandlerDTO(
  handlerId: string | null,
  ref: MemberRef | null,
): InquiryHandlerDTO | null {
  if (!handlerId) return null;
  return {
    id: handlerId,
    // The account can outlive its profile row (or lose it); the id is what the
    // console actually needs, so a missing profile degrades to a placeholder
    // rather than dropping the attribution entirely.
    name: ref ? `${ref.firstName} ${ref.lastName}`.trim() : 'Staff',
  };
}

export function toInquiryDTO(
  inquiry: Inquiry,
  handler: MemberRef | null = null,
): InquiryDTO {
  return {
    id: inquiry.id,
    kind: inquiry.kind,
    name: inquiry.senderName,
    email: inquiry.email,
    subject: inquiry.subject ?? undefined,
    body: inquiry.body,
    orgName: inquiry.orgName ?? undefined,
    status: inquiry.status,
    createdAt: inquiry.createdAt.toISOString(),
    handledAt: inquiry.handledAt ? inquiry.handledAt.toISOString() : null,
    handledBy: toInquiryHandlerDTO(inquiry.handledById, handler),
  };
}

export function toInquiryAckDTO(inquiry: Inquiry): InquiryAckDTO {
  return { id: inquiry.id, status: inquiry.status };
}
