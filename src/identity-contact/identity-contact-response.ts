import type { IdentityEnquiryLimitReason } from './identity-enquiry-quota';

/**
 * Task 18: why a member cannot write to a persona or company mailbox.
 * `own_mailbox` is told only to someone who answers that mailbox;
 * `unstaffed` means nobody could answer (an unclaimed company); `removed` is
 * a persona moderation took down; `unavailable` covers the member's own block
 * of it. None of them names or implies a person.
 */
export type IdentityContactUnavailableReason =
  'own_mailbox' | 'unstaffed' | 'removed' | 'unavailable';

/** `GET /subprofiles/:id/contact` and `GET /companies/:slug/contact`. */
export interface IdentityContactDTO {
  canMessage: boolean;
  unavailableReason: IdentityContactUnavailableReason | null;
  /** True until the mailbox first answers; the member's follow-ups wait on
   *  that reply. */
  followUpAwaitsReply: boolean;
  existingConversationId: string | null;
  hasReachedEnquiryLimit: boolean;
  enquiryLimitReason: IdentityEnquiryLimitReason | null;
  enquiryLimitClearsAt: string | null;
}

/** `POST /subprofiles/:id/enquiries` and `POST /companies/:slug/enquiries`. */
export interface IdentityEnquirySentDTO {
  conversationId: string;
  followUpAwaitsReply: boolean;
}
