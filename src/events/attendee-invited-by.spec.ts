import { Profile } from '../users/entities/profile.entity';
import { invitedByByInvitee } from './attendee-invited-by';
import {
  EventInvite,
  EventInviteSource,
  EventInviteStatus,
} from './entities/event-invite.entity';

function invite(overrides: Partial<EventInvite> = {}): EventInvite {
  return {
    id: 'invite-1',
    eventId: 'event-1',
    inviterId: 'inviter-1',
    inviteeId: 'invitee-1',
    status: EventInviteStatus.Accepted,
    source: EventInviteSource.Member,
    createdAt: new Date('2026-10-21T10:00:00Z'),
    ...overrides,
  };
}

const inviterProfile = {
  userId: 'inviter-1',
  slug: 'inviter-slug',
  firstName: 'Bea',
  lastName: 'Lopes',
  photoVisible: true,
  avatarUrl: null,
} as unknown as Profile;

const inviterProfiles = new Map<string, Profile>([
  ['inviter-1', inviterProfile],
]);

describe('invitedByByInvitee', () => {
  it('maps an accepted member invite to the inviter view', () => {
    const inviterByInviteeId = invitedByByInvitee([invite()], inviterProfiles);

    expect(inviterByInviteeId.get('invitee-1')).toEqual(
      expect.objectContaining({
        slug: 'inviter-slug',
        firstName: 'Bea',
        lastName: 'Lopes',
      }),
    );
  });

  it('ignores host-source invites', () => {
    const inviterByInviteeId = invitedByByInvitee(
      [invite({ source: EventInviteSource.Host })],
      inviterProfiles,
    );

    expect(inviterByInviteeId.size).toBe(0);
  });

  it('ignores pending invites', () => {
    const inviterByInviteeId = invitedByByInvitee(
      [invite({ status: EventInviteStatus.Pending })],
      inviterProfiles,
    );

    expect(inviterByInviteeId.size).toBe(0);
  });

  it('skips an inviter with no profile', () => {
    const inviterByInviteeId = invitedByByInvitee(
      [invite({ inviterId: 'erased-inviter' })],
      inviterProfiles,
    );

    expect(inviterByInviteeId.has('invitee-1')).toBe(false);
  });
});
