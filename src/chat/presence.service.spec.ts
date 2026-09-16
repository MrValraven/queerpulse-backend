import { PresenceService, PRESENCE_GRACE_WINDOW_MS } from './presence.service';

describe('PresenceService', () => {
  let presence: PresenceService;

  beforeEach(() => {
    presence = new PresenceService();
  });

  afterEach(() => {
    jest.useRealTimers();
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

  // ENG-219: a server-initiated token-expiry drop is a PLANNED reconnect, not
  // a genuine disconnect, so it must not flap the member offline for the
  // moment it takes to reconnect on a freshly-refreshed token.
  describe('grace period (ENG-219)', () => {
    it('an ungraced removal reports offline immediately, unchanged from before', () => {
      presence.add('u1', 's1');
      const onGraceExpired = jest.fn();

      const wentOffline = presence.remove('u1', 's1', {
        isGraced: false,
        onGraceExpired,
      });

      expect(wentOffline).toBe(true);
      expect(presence.isOnline('u1')).toBe(false);
      expect(onGraceExpired).not.toHaveBeenCalled();
    });

    it('a graced removal keeps the member online and defers the transition', () => {
      jest.useFakeTimers();
      presence.add('u1', 's1');
      const onGraceExpired = jest.fn();

      const wentOffline = presence.remove('u1', 's1', {
        isGraced: true,
        onGraceExpired,
      });

      // No immediate broadcast: the caller must not report offline now.
      expect(wentOffline).toBe(false);
      // Still reported online through the grace window.
      expect(presence.isOnline('u1')).toBe(true);
      expect(onGraceExpired).not.toHaveBeenCalled();

      jest.advanceTimersByTime(PRESENCE_GRACE_WINDOW_MS);

      expect(onGraceExpired).toHaveBeenCalledTimes(1);
      expect(presence.isOnline('u1')).toBe(false);
    });

    it('a reconnect within the grace window cancels the pending offline without a duplicate online transition', () => {
      jest.useFakeTimers();
      presence.add('u1', 's1');
      const onGraceExpired = jest.fn();
      presence.remove('u1', 's1', { isGraced: true, onGraceExpired });

      // The member's next socket arrives partway through the window.
      jest.advanceTimersByTime(PRESENCE_GRACE_WINDOW_MS / 2);
      const wentOnline = presence.add('u1', 's2');

      expect(wentOnline).toBe(false); // never actually left, so no re-broadcast
      expect(presence.isOnline('u1')).toBe(true);

      // Proves the grace timer was actually cancelled, and did not merely
      // get outrun: advancing past where it would have fired confirms it
      // was cleared and is no longer pending.
      jest.advanceTimersByTime(PRESENCE_GRACE_WINDOW_MS);
      expect(onGraceExpired).not.toHaveBeenCalled();
      expect(presence.isOnline('u1')).toBe(true);
    });

    it('onlineUserIds includes a member currently inside their grace window', () => {
      jest.useFakeTimers();
      presence.add('u1', 's1');
      presence.remove('u1', 's1', { isGraced: true });

      expect(presence.onlineUserIds()).toContain('u1');
    });

    it('a genuine disconnect during another member’s grace window is unaffected', () => {
      jest.useFakeTimers();
      presence.add('graced-user', 'g1');
      presence.add('other-user', 'o1');
      presence.remove('graced-user', 'g1', { isGraced: true });

      const wentOffline = presence.remove('other-user', 'o1');

      expect(wentOffline).toBe(true);
      expect(presence.isOnline('other-user')).toBe(false);
      expect(presence.isOnline('graced-user')).toBe(true);
    });

    // A second graced `remove` landing for the same member while a timer is
    // already pending, without an intervening `add` in between (e.g. a
    // duplicate disconnect event for the same socket), must actually cancel
    // the first timer. Merely losing track of it in the map would leave it
    // orphaned but still running, and it would still fire on its own
    // original schedule and could report the member offline well after this
    // replacement transition already resolved things.
    it('clears an existing pending timer before scheduling its replacement, so the stale one never fires', () => {
      jest.useFakeTimers();
      presence.add('u1', 's1');
      const firstOnGraceExpired = jest.fn();
      presence.remove('u1', 's1', {
        isGraced: true,
        onGraceExpired: firstOnGraceExpired,
      });

      // Same socket id removed again with no `add` in between: `sockets`
      // stayed an (empty) Set from the first call, so this re-enters the
      // graced branch and would, without the fix, leak the first timer.
      const secondOnGraceExpired = jest.fn();
      presence.remove('u1', 's1', {
        isGraced: true,
        onGraceExpired: secondOnGraceExpired,
      });

      jest.advanceTimersByTime(PRESENCE_GRACE_WINDOW_MS);

      expect(firstOnGraceExpired).not.toHaveBeenCalled();
      expect(secondOnGraceExpired).toHaveBeenCalledTimes(1);
      expect(presence.isOnline('u1')).toBe(false);
    });
  });
});
