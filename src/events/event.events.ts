export const EVENT_INVITED = 'event.invited';
export const EVENT_WAITLIST_PROMOTED = 'event.waitlist_promoted';

export interface EventInvitedEvent {
  eventId: string;
  inviterId: string;
  inviteeId: string;
}

export interface EventWaitlistPromotedEvent {
  eventId: string;
  userId: string;
}
