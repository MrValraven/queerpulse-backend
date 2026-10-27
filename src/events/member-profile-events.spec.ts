import { memberEventRole } from './member-profile-events';

describe('member profile events', () => {
  describe('memberEventRole', () => {
    it('reads host when the member hosts the event', () => {
      expect(memberEventRole({ hostId: 'member-1' }, 'member-1')).toBe('host');
    });

    it('reads cohost when someone else hosts the event', () => {
      expect(memberEventRole({ hostId: 'host-2' }, 'member-1')).toBe('cohost');
    });

    it('reads cohost when the host erased their account', () => {
      expect(memberEventRole({ hostId: null }, 'member-1')).toBe('cohost');
    });
  });
});
