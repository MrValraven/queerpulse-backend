import {
  AccessTier,
  Community,
  CommunityType,
} from '../communities/entities/community.entity';
import {
  activityLabelFor,
  computeHealthBreakdown,
  computeHealthScore,
  initialsFor,
  NEW_COMMUNITY_GRACE_PERIOD_DAYS,
  SUPPORT_OPEN_REPORT_THRESHOLD,
  toAdminCommunityCard,
  toneFor,
  type CommunityAggregates,
} from './admin-communities-response';

function makeAggregates(
  overrides: Partial<CommunityAggregates> = {},
): CommunityAggregates {
  return {
    memberCount: 100,
    activeThisWeek: 40,
    postsThisWeek: 20,
    weeklyActivity: [1, 2, 3, 4, 5, 6, 7, 8],
    totalReportCount: 10,
    openReportCount: 2,
    overdueOpenReportCount: 0,
    severityWeightedOpenLoad: 4,
    // Well past NEW_COMMUNITY_GRACE_PERIOD_DAYS by default, so existing
    // fixtures describe an established community unless a test says
    // otherwise — the grace period is exercised explicitly below.
    communityAgeInDays: 400,
    ...overrides,
  };
}

function makeCommunity(overrides: Partial<Community> = {}): Community {
  return {
    id: 'community-1',
    slug: 'circle-of-care',
    name: 'Circle of Care',
    purpose: 'A place to land softly.',
    type: CommunityType.Support,
    whoFor: 'Anyone who needs it.',
    tagline: 'Softly, together.',
    accessTier: AccessTier.Request,
    rosterVisible: true,
    features: [],
    rules: [],
    ownerId: 'user-owner',
    ref: 'CMT-0001',
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    updatedAt: new Date('2025-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('computeHealthBreakdown', () => {
  it('always reports member sentiment as null, because nothing measures it yet', () => {
    const breakdown = computeHealthBreakdown(makeAggregates());
    expect(breakdown.memberSentiment).toBeNull();
  });

  it('scores report resolution at 100 when a community has never been reported', () => {
    // Absence of reports is a healthy state, not missing data. Scoring an
    // unreported community 0 would rank the calmest spaces as the sickest.
    const breakdown = computeHealthBreakdown(
      makeAggregates({
        totalReportCount: 0,
        openReportCount: 0,
        severityWeightedOpenLoad: 0,
      }),
    );
    expect(breakdown.reportResolution).toBe(100);
    expect(breakdown.safetyLoad).toBe(100);
  });

  it('scores member activity as the share of members active this week', () => {
    const breakdown = computeHealthBreakdown(
      makeAggregates({ memberCount: 200, activeThisWeek: 50 }),
    );
    expect(breakdown.memberActivity).toBe(25);
  });

  it('caps member activity at 100 when activity outruns the roster', () => {
    const breakdown = computeHealthBreakdown(
      makeAggregates({ memberCount: 10, activeThisWeek: 40 }),
    );
    expect(breakdown.memberActivity).toBe(100);
  });

  it('scores an empty community at 0 activity without dividing by zero', () => {
    const breakdown = computeHealthBreakdown(
      makeAggregates({ memberCount: 0, activeThisWeek: 0 }),
    );
    expect(breakdown.memberActivity).toBe(0);
    expect(Number.isFinite(breakdown.memberActivity)).toBe(true);
  });

  it('scores report resolution as the share of reports no longer open', () => {
    const breakdown = computeHealthBreakdown(
      makeAggregates({ totalReportCount: 10, openReportCount: 3 }),
    );
    expect(breakdown.reportResolution).toBe(70);
  });

  it('drives safety load down as weighted open reports mount per member', () => {
    const calm = computeHealthBreakdown(
      makeAggregates({ memberCount: 100, severityWeightedOpenLoad: 1 }),
    );
    const strained = computeHealthBreakdown(
      makeAggregates({ memberCount: 100, severityWeightedOpenLoad: 40 }),
    );
    expect(strained.safetyLoad).toBeLessThan(calm.safetyLoad);
    expect(strained.safetyLoad).toBeGreaterThanOrEqual(0);
  });

  it('penalises overdue open reports beyond their severity weight', () => {
    const onTime = computeHealthBreakdown(
      makeAggregates({ openReportCount: 4, overdueOpenReportCount: 0 }),
    );
    const overdue = computeHealthBreakdown(
      makeAggregates({ openReportCount: 4, overdueOpenReportCount: 4 }),
    );
    expect(overdue.safetyLoad).toBeLessThan(onTime.safetyLoad);
  });
});

describe('computeHealthScore', () => {
  it('averages only the signals that have data, skipping null sentiment', () => {
    const score = computeHealthScore({
      memberActivity: 60,
      reportResolution: 90,
      memberSentiment: null,
      safetyLoad: 90,
    });
    expect(score).toBe(80);
  });

  it('does not let the unmeasured sentiment signal drag the average toward zero', () => {
    const score = computeHealthScore({
      memberActivity: 100,
      reportResolution: 100,
      memberSentiment: null,
      safetyLoad: 100,
    });
    expect(score).toBe(100);
  });
});

describe('activityLabelFor', () => {
  it('calls a community with no posts this week Quiet', () => {
    expect(activityLabelFor(makeAggregates({ postsThisWeek: 0 }))).toBe(
      'Quiet',
    );
  });

  it('calls a busy, widely-participating community High', () => {
    expect(
      activityLabelFor(
        makeAggregates({
          memberCount: 100,
          activeThisWeek: 70,
          postsThisWeek: 90,
        }),
      ),
    ).toBe('High');
  });
});

describe('initialsFor', () => {
  it('takes the first letter of the first two words', () => {
    expect(initialsFor('Trans & Friends')).toBe('TF');
  });

  it('falls back to the first two letters of a single-word name', () => {
    expect(initialsFor('Nightlife')).toBe('NI');
  });

  it('ignores an ampersand rather than rendering it as an initial', () => {
    expect(initialsFor('Elders & Memory')).toBe('EM');
  });
});

describe('toneFor', () => {
  it('is stable for the same slug across calls', () => {
    expect(toneFor('trans-friends')).toBe(toneFor('trans-friends'));
  });

  it('only ever returns a known badge tone', () => {
    const tones = ['plum', 'coral', 'jade', 'violet', 'amber'];
    for (const slug of ['a', 'bb', 'ccc', 'trans-friends', 'lisbon-queers']) {
      expect(tones).toContain(toneFor(slug));
    }
  });
});

describe('toAdminCommunityCard needsSupport (new-community grace period)', () => {
  // A community with one member and no activity yet: memberActivity is 0
  // purely because nobody has had a week to be "active" in, not because
  // anything is wrong. No reports at all, so reportResolution and
  // safetyLoad both read as fully healthy (100).
  const quietStartAggregates: Partial<CommunityAggregates> = {
    memberCount: 1,
    activeThisWeek: 0,
    postsThisWeek: 0,
    totalReportCount: 0,
    openReportCount: 0,
    overdueOpenReportCount: 0,
    severityWeightedOpenLoad: 0,
  };

  it('does not flag a brand-new community that is simply quiet', () => {
    const card = toAdminCommunityCard(
      makeCommunity(),
      makeAggregates({
        ...quietStartAggregates,
        communityAgeInDays: 0,
      }),
    );

    // Without the grace period this would score well below
    // SUPPORT_HEALTH_THRESHOLD on memberActivity alone, and the finding this
    // fix addresses is exactly that: a brand-new, healthy community getting
    // flagged and sorted above communities with real open incidents.
    expect(card.healthScore).toBeLessThan(78);
    expect(card.needsSupport).toBe(false);
  });

  it('flags an established community that is just as quiet', () => {
    const card = toAdminCommunityCard(
      makeCommunity(),
      makeAggregates({
        ...quietStartAggregates,
        communityAgeInDays: NEW_COMMUNITY_GRACE_PERIOD_DAYS,
      }),
    );

    // Same signals as the brand-new case above, but the community has had
    // long enough to matter: a genuinely quiet, understaffed community must
    // still be caught, not waved through forever.
    expect(card.healthScore).toBeLessThan(78);
    expect(card.needsSupport).toBe(true);
  });

  it('always flags a brand-new community with a real open-report emergency', () => {
    const card = toAdminCommunityCard(
      makeCommunity(),
      makeAggregates({
        memberCount: 1,
        activeThisWeek: 0,
        postsThisWeek: 0,
        // Kept internally consistent: every one of these reports is open,
        // so totalReportCount and severityWeightedOpenLoad both reflect all
        // SUPPORT_OPEN_REPORT_THRESHOLD of them (one weighted point each,
        // i.e. ReportSeverity.Low) rather than leaving a report tally with
        // no matching weighted load.
        totalReportCount: SUPPORT_OPEN_REPORT_THRESHOLD,
        openReportCount: SUPPORT_OPEN_REPORT_THRESHOLD,
        overdueOpenReportCount: 0,
        severityWeightedOpenLoad: SUPPORT_OPEN_REPORT_THRESHOLD,
        communityAgeInDays: 0,
      }),
    );

    // The grace period never covers a real, open incident — age is
    // irrelevant once the open-report threshold is hit.
    expect(card.needsSupport).toBe(true);
  });
});
