import { Profile } from '../users/entities/profile.entity';
import {
  EventInvite,
  EventInviteSource,
  EventInviteStatus,
} from './entities/event-invite.entity';
import { EventOrganizerView, toOrganizerView } from './event-response';

/**
 * Maps each invitee to the member who invited them, for the organiser's
 * "Invited by" line on the attendee list.
 *
 * Only accepted member invites count: a host invite names the host, which
 * the organiser already knows, and a pending invite has not brought anyone
 * in yet. An inviter whose profile is gone (an erased account) is skipped,
 * so the row reads as nobody's guest.
 */
export function invitedByByInvitee(
  acceptedMemberInvites: EventInvite[],
  inviterProfiles: Map<string, Profile>,
): Map<string, EventOrganizerView> {
  const inviterByInviteeId = new Map<string, EventOrganizerView>();
  for (const invite of acceptedMemberInvites) {
    if (invite.source !== EventInviteSource.Member) continue;
    if (invite.status !== EventInviteStatus.Accepted) continue;
    const inviterView = toOrganizerView(inviterProfiles.get(invite.inviterId));
    if (!inviterView) continue;
    inviterByInviteeId.set(invite.inviteeId, inviterView);
  }
  return inviterByInviteeId;
}
