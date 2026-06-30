import { PresenceService } from './presence.service';

describe('PresenceService', () => {
  let presence: PresenceService;

  beforeEach(() => {
    presence = new PresenceService();
  });

  it('reports the first socket as a transition to online', () => {
    expect(presence.add('u1', 's1')).toBe(true);
    expect(presence.isOnline('u1')).toBe(true);
  });

  it('does not re-transition on a second socket for the same user', () => {
    presence.add('u1', 's1');
    expect(presence.add('u1', 's2')).toBe(false);
    expect(presence.isOnline('u1')).toBe(true);
  });

  it('stays online until the last socket disconnects', () => {
    presence.add('u1', 's1');
    presence.add('u1', 's2');
    expect(presence.remove('u1', 's1')).toBe(false);
    expect(presence.isOnline('u1')).toBe(true);
    expect(presence.remove('u1', 's2')).toBe(true);
    expect(presence.isOnline('u1')).toBe(false);
  });

  it('remove on an unknown user is a no-op', () => {
    expect(presence.remove('ghost', 's1')).toBe(false);
  });
});
