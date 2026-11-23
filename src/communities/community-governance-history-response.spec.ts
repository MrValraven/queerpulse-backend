import { Repository } from 'typeorm';
import {
  CommunityGovernanceLog,
  GovernanceLogAction,
} from './entities/community-governance-log.entity';
import { toCommunityGovernanceLogDetails } from './community-governance-history-response';
import { writeGovernanceLogEntry } from './community-governance-log.service';

describe('toCommunityGovernanceLogDetails for badges and gifts', () => {
  it('reads the badge fields of a badge_deleted entry', () => {
    expect(
      toCommunityGovernanceLogDetails({
        badgeId: 'badge-1',
        badgeName: 'Regular',
        holderCount: 4,
      }),
    ).toEqual({ badgeId: 'badge-1', badgeName: 'Regular', holderCount: 4 });
  });

  it('reads the badge_updated diff through changedSettings', () => {
    expect(
      toCommunityGovernanceLogDetails({
        badgeId: 'badge-1',
        badgeName: 'Regulars',
        changes: {
          name: { from: 'Regular', to: 'Regulars' },
          threshold: { from: 3, to: 2 },
        },
      }),
    ).toEqual({
      badgeId: 'badge-1',
      badgeName: 'Regulars',
      changedSettings: [
        { field: 'name', from: 'Regular', to: 'Regulars' },
        { field: 'threshold', from: 3, to: 2 },
      ],
    });
  });

  it('reads the gift fields beside the shared note field', () => {
    expect(
      toCommunityGovernanceLogDetails({
        giftId: 'gift-1',
        giftKey: 'heart',
        note: 'secret',
      }),
    ).toEqual({ giftId: 'gift-1', giftKey: 'heart', note: 'secret' });
  });

  it('drops a holder count that is no number', () => {
    expect(toCommunityGovernanceLogDetails({ holderCount: '4' })).toEqual({});
  });

  it('keeps a platform takedown of a gift empty', () => {
    expect(
      toCommunityGovernanceLogDetails({
        giftId: 'gift-1',
        giftKey: 'heart',
        adminOverride: true,
      }),
    ).toEqual({});
  });
});

describe('writeGovernanceLogEntry', () => {
  it('writes one entry through the shared writer', async () => {
    const repository = {
      create: jest.fn((value: object) => value),
      save: jest.fn().mockResolvedValue(undefined),
    };

    await writeGovernanceLogEntry(
      repository as unknown as Repository<CommunityGovernanceLog>,
      {
        communityId: 'c1',
        actorUserId: null,
        action: GovernanceLogAction.GiftRemoved,
        targetUserId: 'u2',
        metadata: { giftId: 'gift-1' },
      },
    );

    expect(repository.save).toHaveBeenCalledWith({
      communityId: 'c1',
      actorUserId: null,
      action: 'gift_removed',
      targetUserId: 'u2',
      metadata: { giftId: 'gift-1' },
    });
  });
});
