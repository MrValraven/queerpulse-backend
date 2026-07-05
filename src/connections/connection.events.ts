export const CONNECTION_ACCEPTED = 'connection.accepted';

export interface ConnectionAcceptedEvent {
  connectionId: string;
  requesterId: string;
  addresseeId: string;
  requestMessage: string | null;
}

export const CONNECTION_REQUESTED = 'connection.requested';

export interface ConnectionRequestedEvent {
  connectionId: string;
  requesterId: string;
  addresseeId: string;
  introducedBy?: string | null;
}
