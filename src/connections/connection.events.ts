export const CONNECTION_ACCEPTED = 'connection.accepted';

export interface ConnectionAcceptedEvent {
  connectionId: string;
  requesterId: string;
  addresseeId: string;
  requestMessage: string | null;
  /**
   * PRD-340: reply-implies-accept. Set only by
   * `ConnectionsService.respondWithReply`: the addressee's own reply,
   * accepted and delivered in the one action. Absent for a plain
   * `respond('accept', ...)`, so `MessageRequestsService`'s listener posts
   * nothing extra for that path and every existing accept flow (button,
   * profile modal) is unchanged.
   */
  replyBody?: string;
}

export const CONNECTION_REQUESTED = 'connection.requested';

export interface ConnectionRequestedEvent {
  connectionId: string;
  requesterId: string;
  addresseeId: string;
  introducedBy?: string | null;
}
