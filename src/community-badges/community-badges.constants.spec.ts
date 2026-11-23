import { CommunityBadgeRuleType } from './community-badges.catalog';
import {
  COMMUNITY_BADGE_REFUSALS,
  COMMUNITY_GIFT_SUBJECT_TYPE,
  CommunityBadgeRefusalCode,
  communityBadgeError,
  spaceFeatureUnavailableError,
} from './community-badges.constants';

describe('community badge refusals', () => {
  it('answers the weekly cap with 429, the limit and the reset time', () => {
    const error = communityBadgeError('gift_weekly_limit_reached', {
      limit: 10,
      resetsAt: '2026-11-29T10:00:00.000Z',
    });
    expect(error.getStatus()).toBe(429);
    expect(error.getResponse()).toEqual({
      statusCode: 429,
      message: 'You have sent 10 gifts in this community in the last 7 days.',
      code: 'gift_weekly_limit_reached',
      limit: 10,
      resetsAt: '2026-11-29T10:00:00.000Z',
    });
  });

  it('carries the rule range on an out of range threshold', () => {
    expect(
      communityBadgeError('badge_threshold_out_of_range', {
        ruleType: CommunityBadgeRuleType.TenureDays,
        min: 30,
        max: 3650,
      }).getResponse(),
    ).toEqual(
      expect.objectContaining({ ruleType: 'tenure_days', min: 30, max: 3650 }),
    );
  });

  it('drops extras a code does not list', () => {
    expect(
      communityBadgeError('gift_not_found', { limit: 3 }).getResponse(),
    ).toEqual({
      statusCode: 404,
      message: 'Gift not found.',
      code: 'gift_not_found',
    });
  });

  it('gives every code a status and a message', () => {
    for (const [code, refusal] of Object.entries(COMMUNITY_BADGE_REFUSALS)) {
      expect(refusal.message.length).toBeGreaterThan(0);
      expect(
        communityBadgeError(code as CommunityBadgeRefusalCode).getStatus(),
      ).toBe(refusal.status);
    }
    expect(Object.keys(COMMUNITY_BADGE_REFUSALS)).toHaveLength(27);
  });

  it('answers a space with the shared space code', () => {
    expect(spaceFeatureUnavailableError().getResponse()).toEqual(
      expect.objectContaining({
        statusCode: 400,
        code: 'SUBCOMMUNITY_FEATURE_UNAVAILABLE',
      }),
    );
  });

  it('names the report and takedown subject', () => {
    expect(COMMUNITY_GIFT_SUBJECT_TYPE).toBe('community_gift');
  });
});
