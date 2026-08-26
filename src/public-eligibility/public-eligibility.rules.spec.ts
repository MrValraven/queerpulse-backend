import {
  CAP,
  TARGET_SCORE,
  TENURE_FLOOR_DAYS,
  evaluatePublicEligibility,
} from './public-eligibility.rules';
import {
  PUBLIC_ELIGIBILITY_REASON,
  RawSignals,
} from './public-eligibility-response';

const NOW = '2026-08-25T00:00:00.000Z';
/** Inside the six-month recency window relative to NOW. */
const RECENT = '2026-07-01T00:00:00.000Z';
/** Well outside it, so it decays to half weight. */
const STALE = '2024-01-01T00:00:00.000Z';

function signals(overrides: Partial<RawSignals> = {}): RawSignals {
  return {
    verified: true,
    tenureDays: 400,
    publishedPieces: [],
    hostedOpenEvents: [],
    publishedSubprofiles: 0,
    vouchCount: 0,
    vouchesGivenCount: 0,
    endorsementCount: 0,
    connectionCount: 0,
    eventsAttended: 0,
    communityPosts: 0,
    lastActiveDaysAgo: 0,
    standingOk: true,
    ...overrides,
  };
}

/** A member who clears every gate and maxes every family. */
function qualifying(overrides: Partial<RawSignals> = {}): RawSignals {
  return signals({
    verified: true,
    tenureDays: 400,
    publishedPieces: [RECENT, RECENT, RECENT],
    hostedOpenEvents: [RECENT, RECENT],
    publishedSubprofiles: 2,
    vouchCount: 5,
    endorsementCount: 6,
    connectionCount: 12,
    eventsAttended: 6,
    communityPosts: 8,
    lastActiveDaysAgo: 0,
    standingOk: true,
    ...overrides,
  });
}

describe('evaluatePublicEligibility', () => {
  describe('the hard gates', () => {
    it('locks an unverified member however high they score', () => {
      const decision = evaluatePublicEligibility(
        qualifying({ verified: false }),
        NOW,
      );

      expect(decision.score.total).toBe(TARGET_SCORE);
      expect(decision.gates.isVerifiedMet).toBe(false);
      expect(decision.isEligible).toBe(false);
      expect(decision.reasonCode).toBe(PUBLIC_ELIGIBILITY_REASON.NotVerified);
    });

    // The 90-day floor is deliberate policy. If this number ever changes it
    // has to change here, in the one place that applies it.
    it('locks a member one day short of the tenure floor', () => {
      const decision = evaluatePublicEligibility(
        qualifying({ tenureDays: TENURE_FLOOR_DAYS - 1 }),
        NOW,
      );

      expect(decision.gates.isTenureMet).toBe(false);
      expect(decision.gates.tenureDaysRemaining).toBe(1);
      expect(decision.isEligible).toBe(false);
      expect(decision.reasonCode).toBe(
        PUBLIC_ELIGIBILITY_REASON.TenureTooShort,
      );
    });

    it('opens the tenure gate exactly at the floor', () => {
      const decision = evaluatePublicEligibility(
        qualifying({ tenureDays: TENURE_FLOOR_DAYS }),
        NOW,
      );

      expect(decision.gates.isTenureMet).toBe(true);
      expect(decision.gates.tenureDaysRemaining).toBe(0);
    });

    it('reports the floor so the client needs no copy of it', () => {
      expect(
        evaluatePublicEligibility(signals(), NOW).gates.tenureFloorDays,
      ).toBe(TENURE_FLOOR_DAYS);
    });
  });

  describe('the standing veto', () => {
    // Silent on purpose: a member under a moderator takedown must not be able
    // to read that off this API, so the reason stays the generic catch-all.
    it('locks a member with bad standing without naming the reason', () => {
      const decision = evaluatePublicEligibility(
        qualifying({ standingOk: false }),
        NOW,
      );

      expect(decision.isStandingOk).toBe(false);
      expect(decision.isEligible).toBe(false);
      expect(decision.reasonCode).toBe(PUBLIC_ELIGIBILITY_REASON.NotEligible);
    });
  });

  describe('the score', () => {
    it('unlocks a fully qualifying member at the target', () => {
      const decision = evaluatePublicEligibility(qualifying(), NOW);

      expect(decision.score.total).toBe(TARGET_SCORE);
      expect(decision.score.target).toBe(TARGET_SCORE);
      expect(decision.isEligible).toBe(true);
      expect(decision.reasonCode).toBeNull();
    });

    it('locks a verified, long-tenured member who has done nothing', () => {
      const decision = evaluatePublicEligibility(signals(), NOW);

      expect(decision.gates.isVerifiedMet).toBe(true);
      expect(decision.gates.isTenureMet).toBe(true);
      expect(decision.score.total).toBeLessThan(TARGET_SCORE);
      expect(decision.isEligible).toBe(false);
      expect(decision.reasonCode).toBe(
        PUBLIC_ELIGIBILITY_REASON.ScoreBelowTarget,
      );
    });

    it('never reports a total above the target', () => {
      const decision = evaluatePublicEligibility(
        qualifying({
          publishedPieces: Array<string>(20).fill(RECENT),
          hostedOpenEvents: Array<string>(20).fill(RECENT),
          vouchCount: 30,
        }),
        NOW,
      );

      expect(decision.score.total).toBe(TARGET_SCORE);
    });

    it('caps each family at its own ceiling', () => {
      const decision = evaluatePublicEligibility(
        qualifying({
          publishedPieces: Array<string>(20).fill(RECENT),
          vouchCount: 30,
          endorsementCount: 30,
          connectionCount: 300,
          eventsAttended: 30,
          communityPosts: 30,
          tenureDays: 4000,
        }),
        NOW,
      );

      const byKey = (key: string) =>
        decision.score.families.find((family) => family.key === key)!;
      expect(byKey('contribution').points).toBe(CAP.contribution);
      expect(byKey('trust').points).toBe(CAP.trust);
      expect(byKey('participation').points).toBe(CAP.participation);
    });

    // Recency decay: a stale piece is worth half, so the same three pieces
    // score lower once they age out of the six-month window.
    it('halves the weight of a piece older than the recency window', () => {
      const recent = evaluatePublicEligibility(
        signals({ publishedPieces: [RECENT] }),
        NOW,
      );
      const stale = evaluatePublicEligibility(
        signals({ publishedPieces: [STALE] }),
        NOW,
      );

      const contribution = (decision: typeof recent) =>
        decision.score.families.find((family) => family.key === 'contribution')!
          .points;
      expect(contribution(recent)).toBe(20);
      expect(contribution(stale)).toBe(10);
    });

    // Full-weight pieces claim the biggest series slots first, so ordering the
    // input differently must not change the answer.
    it('is order-independent across mixed-recency pieces', () => {
      const first = evaluatePublicEligibility(
        signals({ publishedPieces: [STALE, RECENT] }),
        NOW,
      );
      const second = evaluatePublicEligibility(
        signals({ publishedPieces: [RECENT, STALE] }),
        NOW,
      );

      expect(first.score.total).toBe(second.score.total);
    });

    // The trust family's shape: a single vouch earns partial credit, the "2+"
    // bar is a step, and the third vouch is another.
    it('steps the trust family at the 2nd and 3rd vouch', () => {
      const trust = (vouchCount: number) =>
        evaluatePublicEligibility(
          signals({ vouchCount }),
          NOW,
        ).score.families.find((family) => family.key === 'trust')!.points;

      expect(trust(0)).toBe(0);
      expect(trust(1)).toBe(4);
      expect(trust(2)).toBe(12);
      expect(trust(3)).toBe(20);
      expect(trust(4)).toBe(25);
    });

    it('pays the recent-activity bonus only inside the active window', () => {
      const participation = (lastActiveDaysAgo: number) =>
        evaluatePublicEligibility(
          signals({ lastActiveDaysAgo }),
          NOW,
        ).score.families.find((family) => family.key === 'participation')!
          .points;

      expect(participation(30)).toBe(6);
      expect(participation(31)).toBe(0);
    });
  });
});
