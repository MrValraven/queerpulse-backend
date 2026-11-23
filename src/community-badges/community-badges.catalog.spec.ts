import {
  COMMUNITY_BADGE_ICON_KEYS,
  COMMUNITY_BADGE_RULES,
  COMMUNITY_BADGE_STARTERS,
  COMMUNITY_GIFTS,
  COMMUNITY_GIFT_KEYS,
  codePointLength,
  isCommunityBadgeIconKey,
  isCommunityBadgeRuleType,
  isCommunityFlairTint,
  isCommunityGiftKey,
} from './community-badges.catalog';

describe('community badges catalogue', () => {
  it('lists 24 distinct icon keys', () => {
    expect(COMMUNITY_BADGE_ICON_KEYS).toHaveLength(24);
    expect(new Set(COMMUNITY_BADGE_ICON_KEYS).size).toBe(24);
  });

  it('pins every rule range', () => {
    expect(COMMUNITY_BADGE_RULES).toEqual({
      tenure_days: { min: 30, max: 3650 },
      events_checked_in: { min: 1, max: 500 },
      volunteer_hours: { min: 1, max: 1000 },
      posts_and_replies: { min: 1, max: 5000 },
    });
  });

  it('keeps every starter inside its rule range with a known icon and tint', () => {
    for (const starter of COMMUNITY_BADGE_STARTERS) {
      const range = COMMUNITY_BADGE_RULES[starter.ruleType];
      expect(starter.threshold).toBeGreaterThanOrEqual(range.min);
      expect(starter.threshold).toBeLessThanOrEqual(range.max);
      expect(isCommunityBadgeIconKey(starter.iconKey)).toBe(true);
      expect(isCommunityFlairTint(starter.tint)).toBe(true);
    }
    expect(
      COMMUNITY_BADGE_STARTERS.map((starter) => starter.starterKey),
    ).toEqual([
      'regular',
      'old_friend',
      'helping_hands',
      'in_the_conversation',
    ]);
  });

  it('draws every gift from the badge icons and tints', () => {
    expect(COMMUNITY_GIFTS.map((gift) => gift.key)).toEqual([
      ...COMMUNITY_GIFT_KEYS,
    ]);
    expect(COMMUNITY_GIFTS.find((gift) => gift.key === 'life_buoy')).toEqual({
      key: 'life_buoy',
      iconKey: 'life_buoy',
      tint: 'jade',
    });
    for (const gift of COMMUNITY_GIFTS) {
      expect(isCommunityBadgeIconKey(gift.iconKey)).toBe(true);
      expect(isCommunityFlairTint(gift.tint)).toBe(true);
    }
  });

  it('counts code points for an emoji name', () => {
    expect(codePointLength('Pride \u{1F308}')).toBe(7);
  });

  it.each([42, null, 'Award'])('refuses %p as an icon key', (value) => {
    expect(isCommunityBadgeIconKey(value)).toBe(false);
  });

  it('accepts a known icon key, tint, rule type and gift key', () => {
    expect(isCommunityBadgeIconKey('life_buoy')).toBe(true);
    expect(isCommunityFlairTint('violet')).toBe(true);
    expect(isCommunityBadgeRuleType('tenure_days')).toBe(true);
    expect(isCommunityGiftKey('smile')).toBe(true);
  });

  it('refuses an unknown tint, rule type and gift key', () => {
    expect(isCommunityFlairTint('teal')).toBe(false);
    expect(isCommunityBadgeRuleType('likes_received')).toBe(false);
    expect(isCommunityGiftKey('trophy')).toBe(false);
  });
});
