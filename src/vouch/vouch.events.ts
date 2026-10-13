export const VOUCH_CREATED = 'vouch.created';

export interface VouchCreatedEvent {
  voucherId: string;
  voucheeId: string;
  /**
   * True when the voucher chose to vouch anonymously. The notifications
   * listener must then keep `voucherId` off the bell payload, so the vouchee's
   * bell and push never name the voucher, while still passing the voucher as
   * the block/mute `actorId`.
   */
  anonymous: boolean;
}
