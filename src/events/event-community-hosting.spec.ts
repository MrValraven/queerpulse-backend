import { AccessTier } from '../communities/entities/community.entity';
import {
  ACCEPTED_GUEST_STATUS_SQL,
  MAX_GUEST_COMMUNITIES,
  acceptedGuestExistsSql,
  isPrivateCommunityWithheld,
  toCommunityHostingFields,
} from './event-community-hosting';

describe('event community hosting helpers', () => {
  describe('acceptedGuestExistsSql', () => {
    const guestSql = acceptedGuestExistsSql(
      '"e"."id"',
      'scope_guest',
      '"scope_guest"."community_id" IN (:...viewerCommunityIds)',
    );

    it('reads accepted rows only, through a quoted enum literal', () => {
      expect(ACCEPTED_GUEST_STATUS_SQL).toBe(`'accepted'`);
      expect(guestSql).toContain(`"scope_guest"."status" = 'accepted'`);
    });

    it('correlates on quoted snake_case columns', () => {
      expect(guestSql).toContain('FROM "event_communities" "scope_guest"');
      expect(guestSql).toContain('"scope_guest"."event_id" = "e"."id"');
      expect(guestSql).toContain(
        '"scope_guest"."community_id" IN (:...viewerCommunityIds)',
      );
    });

    it('carries no camelCase property path for TypeORM to leave raw', () => {
      // Any camelCase identifier after a dot (bare or quoted alias) or inside
      // double quotes. A `:...camelCase` bind parameter is fine and passes.
      expect(guestSql).not.toMatch(
        /(?:\b[a-z_]+|")\.[a-z]+[A-Z]\w*|"[a-z]+[A-Z]\w*"/,
      );
    });
  });

  describe('toCommunityHostingFields', () => {
    const leadRef = { slug: 'queerpulse-social', name: 'QueerPulse Social' };

    it('marks the community that leads the gathering as lead with no lead ref', () => {
      expect(toCommunityHostingFields('lead-1', 'lead-1', leadRef)).toEqual({
        hostedAs: 'lead',
        leadCommunity: null,
      });
    });

    it('marks any other listing community as guest and names the lead', () => {
      expect(toCommunityHostingFields('lead-1', 'guest-1', leadRef)).toEqual({
        hostedAs: 'guest',
        leadCommunity: leadRef,
      });
    });

    it('keeps the lead ref null when the lead is withheld from the viewer', () => {
      expect(toCommunityHostingFields('lead-1', 'guest-1', null)).toEqual({
        hostedAs: 'guest',
        leadCommunity: null,
      });
    });

    it('copies only the slug and the name onto the wire', () => {
      const leadWithTier = { ...leadRef, accessTier: AccessTier.Public };
      expect(
        toCommunityHostingFields('lead-1', 'guest-1', leadWithTier)
          .leadCommunity,
      ).toEqual(leadRef);
    });
  });

  describe('isPrivateCommunityWithheld', () => {
    it.each([AccessTier.Public, AccessTier.Request, AccessTier.Invite])(
      'names a %s community to everyone',
      (accessTier) => {
        expect(
          isPrivateCommunityWithheld({
            accessTier,
            isOrganizer: false,
            isOnRoster: false,
          }),
        ).toBe(false);
      },
    );

    it('withholds a private community from an outsider', () => {
      expect(
        isPrivateCommunityWithheld({
          accessTier: AccessTier.Private,
          isOrganizer: false,
          isOnRoster: false,
        }),
      ).toBe(true);
    });

    it('names a private community to an organiser of the gathering', () => {
      expect(
        isPrivateCommunityWithheld({
          accessTier: AccessTier.Private,
          isOrganizer: true,
          isOnRoster: false,
        }),
      ).toBe(false);
    });

    it('names a private community to a viewer on its roster', () => {
      expect(
        isPrivateCommunityWithheld({
          accessTier: AccessTier.Private,
          isOrganizer: false,
          isOnRoster: true,
        }),
      ).toBe(false);
    });
  });

  it('caps a gathering at five guest communities', () => {
    expect(MAX_GUEST_COMMUNITIES).toBe(5);
  });
});
