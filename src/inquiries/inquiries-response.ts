import { Inquiry } from './entities/inquiry.entity';

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
}

/** Minimal acknowledgement for the public submit — no sender data echoed back. */
export interface InquiryAckDTO {
  id: string;
  status: Inquiry['status'];
}

export function toInquiryDTO(inquiry: Inquiry): InquiryDTO {
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
  };
}

export function toInquiryAckDTO(inquiry: Inquiry): InquiryAckDTO {
  return { id: inquiry.id, status: inquiry.status };
}
