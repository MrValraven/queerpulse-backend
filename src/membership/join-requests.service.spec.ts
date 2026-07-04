import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { UsersService } from '../users/users.service';
import { JoinRequest, JoinRequestStatus } from './entities/join-request.entity';
import { JoinRequestsService } from './join-requests.service';

describe('JoinRequestsService.review', () => {
  let service: JoinRequestsService;
  let repo: { findOne: jest.Mock; save: jest.Mock };
  let users: { promoteToActive: jest.Mock };

  beforeEach(async () => {
    repo = {
      findOne: jest.fn(),
      save: jest.fn().mockImplementation(async (r) => r),
    };
    users = { promoteToActive: jest.fn().mockResolvedValue(true) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JoinRequestsService,
        { provide: getRepositoryToken(JoinRequest), useValue: repo },
        { provide: UsersService, useValue: users },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();
    service = module.get(JoinRequestsService);
  });

  it('approves a pending request and promotes its user', async () => {
    repo.findOne.mockResolvedValue({
      id: 'r1',
      userId: 'u1',
      status: JoinRequestStatus.Pending,
    });
    const result = await service.review(
      'r1',
      'mod-1',
      JoinRequestStatus.Approved,
    );
    expect(users.promoteToActive).toHaveBeenCalledWith('u1');
    expect(result.status).toBe(JoinRequestStatus.Approved);
    expect(result.reviewedBy).toBe('mod-1');
    expect(result.reviewedAt).toBeInstanceOf(Date);
  });

  it('declines without promoting', async () => {
    repo.findOne.mockResolvedValue({
      id: 'r1',
      userId: 'u1',
      status: JoinRequestStatus.Pending,
    });
    await service.review('r1', 'mod-1', JoinRequestStatus.Declined);
    expect(users.promoteToActive).not.toHaveBeenCalled();
  });

  it('rejects reviewing a non-pending request', async () => {
    repo.findOne.mockResolvedValue({
      id: 'r1',
      userId: 'u1',
      status: JoinRequestStatus.Approved,
    });
    await expect(
      service.review('r1', 'mod-1', JoinRequestStatus.Approved),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
