import { HttpException } from '@nestjs/common';
import { StudioCopyrightClaimStatus as Status } from './entities/studio-copyright-claim.entity';
import {
  HOLDING_CLAIM_STATUSES,
  LIVE_CLAIM_STATUSES,
  OWNER_VISIBLE_CLAIM_STATUSES,
  STAFF_QUEUE_CLAIM_STATUSES,
  StudioClaimStaffAction,
  assertCounterAllowed,
  assertReplyAllowed,
  assertWithdrawAllowed,
  canCounterClaim,
  canReplyToClaim,
  canWithdrawClaim,
  isHoldingClaimStatus,
  isLiveClaimStatus,
  isOwnerVisibleClaimStatus,
  nextStatusForStaffAction,
} from './studio-claim-rule';

const codeOf = (work: () => unknown): string | undefined => {
  try {
    work();
    return undefined;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code?: string }).code;
  }
};

const EVERY_STATUS = Object.values(Status);

describe('Studio claim rule', () => {
  it('groups the statuses as the contract does', () => {
    expect(LIVE_CLAIM_STATUSES).toEqual([
      Status.Submitted,
      Status.Accepted,
      Status.Countered,
    ]);
    expect(HOLDING_CLAIM_STATUSES).toEqual([Status.Accepted, Status.Countered]);
    expect(OWNER_VISIBLE_CLAIM_STATUSES).toEqual([
      Status.Accepted,
      Status.Countered,
      Status.Upheld,
      Status.Rejected,
    ]);
    expect(STAFF_QUEUE_CLAIM_STATUSES).toEqual([
      Status.Submitted,
      Status.Countered,
    ]);
    expect(EVERY_STATUS.filter(isLiveClaimStatus)).toEqual(LIVE_CLAIM_STATUSES);
    expect(EVERY_STATUS.filter(isHoldingClaimStatus)).toEqual(
      HOLDING_CLAIM_STATUSES,
    );
    expect(EVERY_STATUS.filter(isOwnerVisibleClaimStatus)).toEqual(
      OWNER_VISIBLE_CLAIM_STATUSES,
    );
  });

  // Every (action, status) pair: the next status, or the contract refusal.
  const staffTable: [StudioClaimStaffAction, Status, Status | string][] = [
    ['accept', Status.Submitted, Status.Accepted],
    ['decline', Status.Submitted, Status.Declined],
    ['uphold', Status.Accepted, Status.Upheld],
    ['uphold', Status.Countered, Status.Upheld],
    ['reject', Status.Accepted, Status.Rejected],
    ['reject', Status.Countered, Status.Rejected],
    ...EVERY_STATUS.filter((status) => status !== Status.Submitted).flatMap(
      (status): [StudioClaimStaffAction, Status, string][] => [
        ['accept', status, 'studio_claim_not_submitted'],
        ['decline', status, 'studio_claim_not_submitted'],
      ],
    ),
    ...EVERY_STATUS.filter(
      (status) => status !== Status.Accepted && status !== Status.Countered,
    ).flatMap((status): [StudioClaimStaffAction, Status, string][] => [
      ['uphold', status, 'studio_claim_not_decidable'],
      ['reject', status, 'studio_claim_not_decidable'],
    ]),
  ];

  it.each(staffTable)('%s on %s gives %s', (action, status, expected) => {
    if (EVERY_STATUS.includes(expected as Status)) {
      expect(nextStatusForStaffAction(action, status)).toBe(expected);
    } else {
      expect(codeOf(() => nextStatusForStaffAction(action, status))).toBe(
        expected,
      );
    }
  });

  it('takes one counter-notice, only while accepted', () => {
    expect(
      codeOf(() =>
        assertCounterAllowed({ status: Status.Accepted, counterNote: null }),
      ),
    ).toBeUndefined();
    for (const status of [Status.Countered, Status.Upheld, Status.Rejected]) {
      expect(
        codeOf(() => assertCounterAllowed({ status, counterNote: 'mine' })),
      ).toBe('studio_claim_not_accepted');
    }
    expect(
      canCounterClaim({ status: Status.Accepted, counterNote: null }),
    ).toBe(true);
    expect(
      canCounterClaim({ status: Status.Countered, counterNote: 'mine' }),
    ).toBe(false);
  });

  it('takes one reply, only while countered', () => {
    expect(
      codeOf(() =>
        assertReplyAllowed({ status: Status.Countered, claimantReply: null }),
      ),
    ).toBeUndefined();
    expect(
      codeOf(() =>
        assertReplyAllowed({ status: Status.Countered, claimantReply: 'no' }),
      ),
    ).toBe('studio_claim_already_replied');
    for (const status of EVERY_STATUS.filter(
      (status) => status !== Status.Countered,
    )) {
      expect(
        codeOf(() => assertReplyAllowed({ status, claimantReply: null })),
      ).toBe('studio_claim_not_countered');
    }
    expect(
      canReplyToClaim({ status: Status.Countered, claimantReply: null }),
    ).toBe(true);
    expect(
      canReplyToClaim({ status: Status.Countered, claimantReply: 'no' }),
    ).toBe(false);
  });

  it('withdraws a live claim and refuses a closed one', () => {
    for (const status of LIVE_CLAIM_STATUSES) {
      expect(codeOf(() => assertWithdrawAllowed({ status }))).toBeUndefined();
      expect(canWithdrawClaim({ status })).toBe(true);
    }
    for (const status of [
      Status.Declined,
      Status.Upheld,
      Status.Rejected,
      Status.Withdrawn,
    ]) {
      expect(codeOf(() => assertWithdrawAllowed({ status }))).toBe(
        'studio_claim_not_live',
      );
      expect(canWithdrawClaim({ status })).toBe(false);
    }
  });
});
