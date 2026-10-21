import { EventInviteStatus } from './entities/event-invite.entity';
import {
  RsvpDetailsVisibility,
  RsvpStatus,
} from './entities/event-rsvp.entity';
import {
  InviteeRsvpFacts,
  InviterInviteStatus,
  inviterFacingStatus,
} from './event-invite-response';

function rsvp(
  status: RsvpStatus,
  visibility: RsvpDetailsVisibility | null,
): InviteeRsvpFacts {
  return { status, visibility };
}

describe('inviterFacingStatus', () => {
  const cases: [
    string,
    EventInviteStatus,
    InviteeRsvpFacts | null,
    boolean,
    InviterInviteStatus | null,
  ][] = [
    ['pending gives invited', EventInviteStatus.Pending, null, true, 'invited'],
    [
      'awaiting_host gives awaiting_host',
      EventInviteStatus.AwaitingHost,
      null,
      true,
      'awaiting_host',
    ],
    [
      'host_declined gives host_declined',
      EventInviteStatus.HostDeclined,
      null,
      true,
      'host_declined',
    ],
    [
      'declined gives answered',
      EventInviteStatus.Declined,
      null,
      true,
      'answered',
    ],
    ['withdrawn gives null', EventInviteStatus.Withdrawn, null, true, null],
    [
      'accepted with going/everyone gives going',
      EventInviteStatus.Accepted,
      rsvp(RsvpStatus.Going, 'everyone'),
      false,
      'going',
    ],
    [
      'accepted with going and a null visibility gives going',
      EventInviteStatus.Accepted,
      rsvp(RsvpStatus.Going, null),
      false,
      'going',
    ],
    [
      'accepted with waitlisted/connections while connected gives waitlisted',
      EventInviteStatus.Accepted,
      rsvp(RsvpStatus.Waitlisted, 'connections'),
      true,
      'waitlisted',
    ],
    [
      'accepted with going/connections while not connected gives answered',
      EventInviteStatus.Accepted,
      rsvp(RsvpStatus.Going, 'connections'),
      false,
      'answered',
    ],
    [
      'accepted with going/justMe gives answered',
      EventInviteStatus.Accepted,
      rsvp(RsvpStatus.Going, 'justMe'),
      true,
      'answered',
    ],
    [
      'accepted with maybe gives answered',
      EventInviteStatus.Accepted,
      rsvp(RsvpStatus.Maybe, 'everyone'),
      true,
      'answered',
    ],
    [
      'accepted with a cancelled RSVP gives answered',
      EventInviteStatus.Accepted,
      rsvp(RsvpStatus.Cancelled, 'everyone'),
      true,
      'answered',
    ],
    [
      'accepted with no RSVP gives answered',
      EventInviteStatus.Accepted,
      null,
      true,
      'answered',
    ],
  ];

  it.each(cases)(
    '%s',
    (_label, inviteStatus, inviteeRsvp, isInviterConnected, expected) => {
      expect(
        inviterFacingStatus(inviteStatus, inviteeRsvp, isInviterConnected),
      ).toBe(expected);
    },
  );
});
