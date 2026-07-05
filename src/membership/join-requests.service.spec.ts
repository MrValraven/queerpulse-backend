import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, QueryFailedError } from 'typeorm';
import { UserStatus } from '../users/entities/user.entity';
import { USER_PROMOTED } from '../users/user.events';
import { UsersService } from '../users/users.service';
import { JoinRequest, JoinRequestStatus } from './entities/join-request.entity';
import { JoinRequestsService } from './join-requests.service';

const uniqueViolation = () =>
  new QueryFailedError('insert', [], {
    code: '23505',
  } as unknown as Error);

describe('JoinRequestsService', () => {
  let service: JoinRequestsService;
  let repo: { findOne: jest.Mock; save: jest.Mock; create: jest.Mock };
  let txRepo: { findOne: jest.Mock; update: jest.Mock };
  let users: { findById: jest.Mock; promoteToActive: jest.Mock };
  let emitter: { emit: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  beforeEach(async () => {
    txRepo = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    repo = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockImplementation(async (r) => ({ id: 'r1', ...r })),
      create: jest.fn((v) => v),
    };
    users = {
      findById: jest.fn().mockResolvedValue(null),
      promoteToActive: jest.fn().mockResolvedValue(true),
    };
    emitter = { emit: jest.fn() };
    const manager = { getRepository: jest.fn(() => txRepo) };
    dataSource = {
      transaction: jest.fn().mockImplementation(async (cb) => cb(manager)),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JoinRequestsService,
        { provide: getRepositoryToken(JoinRequest), useValue: repo },
        { provide: UsersService, useValue: users },
        { provide: DataSource, useValue: dataSource },
        { provide: EventEmitter2, useValue: emitter },
      ],
    }).compile();
    service = module.get(JoinRequestsService);
  });

  describe('submit', () => {
    it('rejects an already-active account with 400', async () => {
      users.findById.mockResolvedValue({ id: 'u1', status: UserStatus.Active });
      await expect(service.submit('u1', 'hi')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('rejects a suspended account with 400', async () => {
      users.findById.mockResolvedValue({
        id: 'u1',
        status: UserStatus.Suspended,
      });
      await expect(service.submit('u1', 'hi')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects a duplicate pending request (pre-check) with 409', async () => {
      users.findById.mockResolvedValue({
        id: 'u1',
        status: UserStatus.Pending,
      });
      repo.findOne.mockResolvedValue({ id: 'existing' });
      await expect(service.submit('u1', 'hi')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('maps a 23505 on insert to 409 (partial unique index backstop)', async () => {
      users.findById.mockResolvedValue({
        id: 'u1',
        status: UserStatus.Pending,
      });
      repo.findOne.mockResolvedValue(null);
      repo.save.mockRejectedValue(uniqueViolation());
      await expect(service.submit('u1', 'hi')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('persists a pending request for a pending user', async () => {
      users.findById.mockResolvedValue({
        id: 'u1',
        status: UserStatus.Pending,
      });
      repo.findOne.mockResolvedValue(null);
      const res = await service.submit('u1', 'let me in');
      expect(repo.save).toHaveBeenCalled();
      expect(res.status).toBe(JoinRequestStatus.Pending);
      expect(res.message).toBe('let me in');
    });
  });

  describe('review', () => {
    it('approves a pending request, promotes the user, emits USER_PROMOTED', async () => {
      txRepo.findOne.mockResolvedValue({
        id: 'r1',
        userId: 'u1',
        status: JoinRequestStatus.Pending,
      });
      const result = await service.review(
        'r1',
        'mod-1',
        JoinRequestStatus.Approved,
      );
      expect(txRepo.update).toHaveBeenCalledWith(
        { id: 'r1', status: JoinRequestStatus.Pending },
        expect.objectContaining({
          status: JoinRequestStatus.Approved,
          reviewedBy: 'mod-1',
          reviewedAt: expect.any(Date),
        }),
      );
      expect(users.promoteToActive).toHaveBeenCalledWith('u1', {
        manager: expect.anything(),
      });
      expect(emitter.emit).toHaveBeenCalledWith(USER_PROMOTED, {
        userId: 'u1',
      });
      expect(result.status).toBe(JoinRequestStatus.Approved);
      expect(result.reviewedBy).toBe('mod-1');
    });

    it('declines without promoting or emitting', async () => {
      txRepo.findOne.mockResolvedValue({
        id: 'r1',
        userId: 'u1',
        status: JoinRequestStatus.Pending,
      });
      await service.review('r1', 'mod-1', JoinRequestStatus.Declined);
      expect(users.promoteToActive).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('rejects a non-pending request with 409', async () => {
      txRepo.findOne.mockResolvedValue({
        id: 'r1',
        userId: 'u1',
        status: JoinRequestStatus.Approved,
      });
      await expect(
        service.review('r1', 'mod-1', JoinRequestStatus.Approved),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects when a concurrent reviewer already claimed it (affected 0)', async () => {
      txRepo.findOne.mockResolvedValue({
        id: 'r1',
        userId: 'u1',
        status: JoinRequestStatus.Pending,
      });
      txRepo.update.mockResolvedValue({ affected: 0 });
      await expect(
        service.review('r1', 'mod-1', JoinRequestStatus.Approved),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(users.promoteToActive).not.toHaveBeenCalled();
    });

    it('does not emit USER_PROMOTED when promotion was a no-op (already active)', async () => {
      txRepo.findOne.mockResolvedValue({
        id: 'r1',
        userId: 'u1',
        status: JoinRequestStatus.Pending,
      });
      users.promoteToActive.mockResolvedValue(false);
      await service.review('r1', 'mod-1', JoinRequestStatus.Approved);
      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });
});
