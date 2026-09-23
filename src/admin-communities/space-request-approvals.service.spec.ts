import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  CommunitySpaceRequest,
  CommunitySpaceRequestStatus,
} from '../communities/entities/community-space-request.entity';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { SpaceRequestApprovalsService } from './space-request-approvals.service';

const COMMUNITY = {
  id: 'community-1',
  slug: 'coletivo-gula',
  name: 'Coletivo Gula',
};

describe('SpaceRequestApprovalsService', () => {
  let service: SpaceRequestApprovalsService;
  let requests: { findOne: jest.Mock; save: jest.Mock; update: jest.Mock };
  let notifications: { create: jest.Mock };

  beforeEach(async () => {
    requests = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn((value: CommunitySpaceRequest) => Promise.resolve(value)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    notifications = { create: jest.fn().mockResolvedValue(undefined) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SpaceRequestApprovalsService,
        {
          provide: getRepositoryToken(CommunitySpaceRequest),
          useValue: requests,
        },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = module.get(SpaceRequestApprovalsService);
  });

  it('does nothing when no request is open', async () => {
    await service.closeOpenAsApproved(COMMUNITY, 'admin-1');
    expect(requests.update).not.toHaveBeenCalled();
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('approves the open request and notifies the requester once', async () => {
    requests.findOne.mockResolvedValue({
      id: 'space-request-1',
      communityId: COMMUNITY.id,
      requestedByUserId: 'owner-1',
      status: CommunitySpaceRequestStatus.Open,
    });
    await service.closeOpenAsApproved(COMMUNITY, 'admin-1');
    expect(requests.update).toHaveBeenCalledWith(
      { id: 'space-request-1', status: CommunitySpaceRequestStatus.Open },
      expect.objectContaining({
        status: CommunitySpaceRequestStatus.Approved,
        decidedByUserId: 'admin-1',
        decidedAt: expect.any(Date),
      }),
    );
    expect(notifications.create).toHaveBeenCalledTimes(1);
    expect(notifications.create).toHaveBeenCalledWith(
      'owner-1',
      NotificationType.CommunitySpaceRequestApproved,
      {
        source: 'community',
        communitySlug: COMMUNITY.slug,
        communityName: COMMUNITY.name,
      },
    );
  });

  it('keeps the approval when the notification fails', async () => {
    requests.findOne.mockResolvedValue({
      id: 'space-request-1',
      requestedByUserId: 'owner-1',
      status: CommunitySpaceRequestStatus.Open,
    });
    notifications.create.mockRejectedValue(new Error('push down'));
    await expect(
      service.closeOpenAsApproved(COMMUNITY, 'admin-1'),
    ).resolves.toBeUndefined();
    expect(requests.update).toHaveBeenCalled();
  });

  it('returns without notifying when a concurrent decision closes the request first', async () => {
    requests.findOne.mockResolvedValue({
      id: 'space-request-1',
      requestedByUserId: 'owner-1',
      status: CommunitySpaceRequestStatus.Open,
    });
    requests.update.mockResolvedValue({ affected: 0 });
    await expect(
      service.closeOpenAsApproved(COMMUNITY, 'admin-1'),
    ).resolves.toBeUndefined();
    expect(notifications.create).not.toHaveBeenCalled();
  });
});
