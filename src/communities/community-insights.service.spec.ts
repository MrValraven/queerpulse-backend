import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CommunityInsightsService } from './community-insights.service';
import { CommunityMembershipService } from './community-membership.service';
import { CommunityMember } from './entities/community-member.entity';
import { CommunityPostReply } from './entities/community-post-reply.entity';
import { CommunityPost } from './entities/community-post.entity';

/**
 * The existence-oracle/role gate itself (unknown-or-archived 404,
 * private-outsider 404, non-private 403, private plain-member 403) is now
 * `CommunityMembershipService.assertOwnerOrModBySlug`'s own contract and is
 * covered there. This file only proves `getInsightsBySlug` delegates to it
 * and propagates whatever it throws, rather than re-asserting the gate
 * against a mock that would prove nothing.
 */
describe('CommunityInsightsService community existence gate', () => {
  let service: CommunityInsightsService;
  let membership: { assertOwnerOrModBySlug: jest.Mock };
  let members: { findOne: jest.Mock };

  beforeEach(async () => {
    membership = { assertOwnerOrModBySlug: jest.fn() };
    members = { findOne: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommunityInsightsService,
        { provide: CommunityMembershipService, useValue: membership },
        { provide: getRepositoryToken(CommunityMember), useValue: members },
        { provide: getRepositoryToken(CommunityPost), useValue: {} },
        { provide: getRepositoryToken(CommunityPostReply), useValue: {} },
      ],
    }).compile();

    service = module.get(CommunityInsightsService);
  });

  it('delegates the gate to CommunityMembershipService.assertOwnerOrModBySlug and propagates what it throws', async () => {
    const gateError = new Error('gate refused');
    membership.assertOwnerOrModBySlug.mockRejectedValue(gateError);

    await expect(
      service.getInsightsBySlug('queer-devs', 'user-1'),
    ).rejects.toBe(gateError);
    expect(membership.assertOwnerOrModBySlug).toHaveBeenCalledWith(
      'queer-devs',
      'user-1',
    );
    expect(members.findOne).not.toHaveBeenCalled();
  });
});
