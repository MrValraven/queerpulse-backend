import {
  CohostInviteEventSummaryView,
  CohostInviteInviterView,
} from './cohost-invite-response';
import {
  EventLineupEntry,
  EventLineupEntryStatus,
} from './entities/event-lineup-entry.entity';

/**
 * `GET /event-lineup-invites/:id`, read by the invited member only. Reuses
 * the co-host invite's event and inviter shapes so the client renders the
 * same cards. Attendee counts are always null here: the invite page shows
 * the gathering, and the roster stays on the gathering's own page.
 * `inviter` is null when neither the inviting organizer nor the host has a
 * profile left.
 */
export interface LineupInviteView {
  id: string;
  status: EventLineupEntryStatus;
  role: string;
  createdAt: Date;
  event: CohostInviteEventSummaryView;
  inviter: CohostInviteInviterView | null;
}

export function toLineupInviteView(
  entry: EventLineupEntry,
  event: CohostInviteEventSummaryView,
  inviter: CohostInviteInviterView | null,
): LineupInviteView {
  return {
    id: entry.id,
    status: entry.status,
    role: entry.role,
    createdAt: entry.createdAt,
    event,
    inviter,
  };
}
