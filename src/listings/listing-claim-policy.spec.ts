import {
  ListingClaim,
  ListingClaimStatus,
} from './entities/listing-claim.entity';
import {
  LISTING_CLAIM_EVIDENCE_HINTS,
  LISTING_CLAIM_REVIEW_TURNAROUND_DAYS,
  claimAgeInDays,
  expectedDecisionBy,
  toListingClaimPolicyDTO,
} from './listing-claim-policy';
import { toListingClaimDTO } from './listing-claim-response';

const DAY_MS = 24 * 60 * 60 * 1000;

const baseClaim = (overrides: Partial<ListingClaim> = {}): ListingClaim => ({
  id: 'claim-1',
  listingId: 'listing-1',
  claimantId: 'claimant-1',
  claimant: null,
  note: 'I run this place.',
  status: ListingClaimStatus.Pending,
  reviewedBy: null,
  reviewer: null,
  reviewedAt: null,
  createdAt: new Date('2026-08-01T12:00:00.000Z'),
  ...overrides,
});

const listing = {
  ref: 'QPL-2026-0001',
  slug: 'drama-bar',
  name: 'Drama Bar',
};

describe('listing-claim-policy', () => {
  it('publishes the turnaround and the evidence hints as one defined value', () => {
    const policy = toListingClaimPolicyDTO();
    expect(policy.reviewTurnaroundDays).toBe(
      LISTING_CLAIM_REVIEW_TURNAROUND_DAYS,
    );
    expect(policy.evidenceHints).toEqual([...LISTING_CLAIM_EVIDENCE_HINTS]);
    expect(policy.evidenceHints.length).toBeGreaterThan(0);
  });

  it('hands back a copy of the hints, so a caller cannot mutate the constant', () => {
    const originalLength = toListingClaimPolicyDTO().evidenceHints.length;
    toListingClaimPolicyDTO().evidenceHints.push('injected');
    expect(toListingClaimPolicyDTO().evidenceHints).toHaveLength(
      originalLength,
    );
  });

  it('derives the promised decision date from the filing date', () => {
    const filedAt = new Date('2026-08-01T12:00:00.000Z');
    expect(expectedDecisionBy(filedAt).getTime()).toBe(
      filedAt.getTime() + LISTING_CLAIM_REVIEW_TURNAROUND_DAYS * DAY_MS,
    );
  });

  describe('claimAgeInDays', () => {
    it('counts whole days waited', () => {
      const filedAt = new Date('2026-08-01T12:00:00.000Z');
      const now = new Date('2026-08-07T13:00:00.000Z');
      expect(claimAgeInDays(filedAt, now)).toBe(6);
    });

    it('floors at zero rather than rendering a negative age on clock skew', () => {
      const filedAt = new Date('2026-08-10T12:00:00.000Z');
      const now = new Date('2026-08-09T12:00:00.000Z');
      expect(claimAgeInDays(filedAt, now)).toBe(0);
    });
  });

  describe('on the claim DTO', () => {
    it("carries the listing's public slug, so a claim links to its page", () => {
      // `ref` addresses ownership routes and `slug` addresses the public
      // detail page. A claimant's list needs the second one, and neither
      // stands in for the other.
      const dto = toListingClaimDTO(baseClaim(), listing, null);
      expect(dto.listingSlug).toBe('drama-bar');
      expect(dto.listingRef).toBe('QPL-2026-0001');
    });

    it('a pending claim carries the turnaround and a decision date', () => {
      const dto = toListingClaimDTO(baseClaim(), listing, null);
      expect(dto.reviewTurnaroundDays).toBe(
        LISTING_CLAIM_REVIEW_TURNAROUND_DAYS,
      );
      expect(dto.expectedDecisionBy).toBe(
        expectedDecisionBy(new Date('2026-08-01T12:00:00.000Z')).toISOString(),
      );
    });

    it('a reviewed claim drops the promise and stops ageing at its decision', () => {
      const dto = toListingClaimDTO(
        baseClaim({
          status: ListingClaimStatus.Approved,
          reviewedBy: 'moderator-1',
          reviewedAt: new Date('2026-08-04T12:00:00.000Z'),
        }),
        listing,
        null,
      );
      expect(dto.expectedDecisionBy).toBeNull();
      // Three days from filing to decision, and it stays three forever.
      expect(dto.ageDays).toBe(3);
    });
  });
});
