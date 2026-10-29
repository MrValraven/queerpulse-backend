/**
 * Studio purchase events (contract section 8). Each is emitted with
 * `EventEmitter2` after the transaction commits and carries the purchase id
 * only; the alerts listener re-reads the row and sends while it still holds
 * the status the event names.
 */
export interface StudioPurchaseEvent {
  purchaseId: string;
}

/** A buyer pressed "I've paid". */
export const STUDIO_PURCHASE_CLAIMED = 'studio.purchase.claimed';

/** A persona member confirmed the payment arrived. */
export const STUDIO_PURCHASE_CONFIRMED = 'studio.purchase.confirmed';

/** A persona member declined the claim. */
export const STUDIO_PURCHASE_DECLINED = 'studio.purchase.declined';

/** The pending claim expired (daily cron) or its persona was unlinked. */
export const STUDIO_PURCHASE_EXPIRED = 'studio.purchase.expired';

/** A kept-files audio copy is waiting to be processed. No payload. */
export const STUDIO_KEPT_AUDIO_PENDING = 'studio.kept-audio.pending';
