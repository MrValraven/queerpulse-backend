export const VOUCH_CREATED = 'vouch.created';

export interface VouchCreatedEvent {
  voucherId: string;
  voucheeId: string;
}
