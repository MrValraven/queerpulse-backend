/** Emitted after a credit request commits; `StudioCreditAlertsListener`
 *  tells the credited persona's members. The requesting member's id is for
 *  block and mute filtering only. */
export const STUDIO_CREDIT_REQUESTED = 'studio.credit.requested';

export interface StudioCreditRequestedEvent {
  creditId: string;
  requestingUserId: string;
}

/** Emitted after an accept commits; the listener tells the requesting
 *  persona's members. A decline emits nothing. */
export const STUDIO_CREDIT_ACCEPTED = 'studio.credit.accepted';

export interface StudioCreditAcceptedEvent {
  creditId: string;
  acceptingUserId: string;
}
