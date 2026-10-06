import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateInviteLinkDto } from './dto/create-invite-link.dto';
import {
  inviteLinkUsageFields,
  inviteLinkUsesLeft,
  isInviteLinkUsedUp,
} from './group-invite-link-usage';

describe('PRD-400: group invite link use cap', () => {
  describe('inviteLinkUsesLeft / isInviteLinkUsedUp', () => {
    it('reports null uses left for an unlimited link, which is never used up', () => {
      const convo = { inviteTokenMaxUses: null, inviteTokenUseCount: 40 };
      expect(inviteLinkUsesLeft(convo)).toBeNull();
      expect(isInviteLinkUsedUp(convo)).toBe(false);
    });

    it('counts down a capped link and floors at 0', () => {
      expect(
        inviteLinkUsesLeft({ inviteTokenMaxUses: 5, inviteTokenUseCount: 2 }),
      ).toBe(3);
      expect(
        inviteLinkUsesLeft({ inviteTokenMaxUses: 1, inviteTokenUseCount: 3 }),
      ).toBe(0);
      expect(
        isInviteLinkUsedUp({ inviteTokenMaxUses: 25, inviteTokenUseCount: 25 }),
      ).toBe(true);
    });
  });

  describe('inviteLinkUsageFields', () => {
    const cappedLink = {
      inviteToken: 'tok',
      inviteTokenMaxUses: 5,
      inviteTokenUseCount: 1,
    };

    it('shows the cap and uses left to a caller who may see the token', () => {
      expect(inviteLinkUsageFields(cappedLink, true)).toEqual({
        inviteTokenMaxUses: 5,
        inviteTokenUsesLeft: 4,
      });
    });

    it('hides both from a caller who may not see the token', () => {
      expect(inviteLinkUsageFields(cappedLink, false)).toEqual({
        inviteTokenMaxUses: null,
        inviteTokenUsesLeft: null,
      });
    });

    it('reports both as null when there is no live token', () => {
      expect(
        inviteLinkUsageFields({ ...cappedLink, inviteToken: null }, true),
      ).toEqual({ inviteTokenMaxUses: null, inviteTokenUsesLeft: null });
    });
  });

  describe('CreateInviteLinkDto', () => {
    const errorsFor = async (body: object) =>
      validate(plainToInstance(CreateInviteLinkDto, body));

    it.each([
      {},
      { maxUses: null },
      { maxUses: 1 },
      { maxUses: 5 },
      { maxUses: 25 },
    ])('accepts %j', async (body) => {
      expect(await errorsFor(body)).toHaveLength(0);
    });

    it.each([
      { maxUses: 0 },
      { maxUses: 2 },
      { maxUses: 100 },
      { maxUses: '5' },
    ])('refuses %j', async (body) => {
      expect(await errorsFor(body)).not.toHaveLength(0);
    });
  });
});
