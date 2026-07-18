import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, QueryFailedError } from 'typeorm';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { Vouch } from './entities/vouch.entity';
import { VOUCH_CREATED } from './vouch.events';
import { VouchService } from './vouch.service';

// A 23505 (unique_violation) as TypeORM surfaces it.
const uniqueViolation = () =>
  new QueryFailedError('insert', [], {
    code: '23505',
  } as unknown as Error);

describe('VouchService', () => {
  let service: VouchService;
  let vouches: { findOne: jest.Mock; find: jest.Mock; count: jest.Mock };
  let profiles: { findOne: jest.Mock; find: jest.Mock };
  let manager: { findOne: jest.Mock; insert: jest.Mock; count: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let emitter: { emit: jest.Mock };

  beforeEach(async () => {
    vouches = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    };
    profiles = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
    };
    manager = {
      findOne: jest.fn().mockResolvedValue(null), // the pessimistic-lock read
      insert: jest.fn().mockResolvedValue(undefined),
      count: jest.fn().mockResolvedValue(0),
    };
    dataSource = {
      transaction: jest.fn().mockImplementation(async (cb) => cb(manager)),
    };
    emitter = { emit: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VouchService,
        { provide: getRepositoryToken(Vouch), useValue: vouches },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: DataSource, useValue: dataSource },
        { provide: EventEmitter2, useValue: emitter },
      ],
    }).compile();
    service = module.get(VouchService);
  });

  describe('createVouch', () => {
    it('404s an unknown member', async () => {
      profiles.findOne.mockResolvedValue(null);
      await expect(service.createVouch('u1', 'ghost')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects self-vouch', async () => {
      profiles.findOne.mockResolvedValue({ userId: 'u1', slug: 'me' });
      await expect(service.createVouch('u1', 'me')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects a duplicate vouch found by the pre-check', async () => {
      profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'them' });
      vouches.findOne.mockResolvedValue({ id: 'existing' });
      await expect(service.createVouch('u1', 'them')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('locks the vouchee row before counting', async () => {
      profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'them' });
      manager.count.mockResolvedValue(1);
      await service.createVouch('u1', 'them');
      expect(manager.findOne).toHaveBeenCalledWith(User, {
        where: { id: 'u2' },
        lock: { mode: 'pessimistic_write' },
      });
    });

    it('trims the note and stores empty/whitespace as null', async () => {
      profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'them' });
      await service.createVouch('u1', 'them', '  great person  ');
      expect(manager.insert).toHaveBeenCalledWith(
        Vouch,
        expect.objectContaining({ note: 'great person' }),
      );

      manager.insert.mockClear();
      await service.createVouch('u1', 'them', '   ');
      expect(manager.insert).toHaveBeenCalledWith(
        Vouch,
        expect.objectContaining({ note: null }),
      );
    });

    // Vouches are a trust/recognition signal only — they no longer gate
    // membership. There is no threshold, no promotion, and no USER_PROMOTED
    // here; the vouch count is returned for display and nothing else.
    it('returns the vouch count and emits only VOUCH_CREATED', async () => {
      profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'them' });
      manager.count.mockResolvedValue(2);
      const result = await service.createVouch('u1', 'them');
      expect(result).toEqual({ vouchCount: 2 });
      expect(emitter.emit).toHaveBeenCalledTimes(1);
      expect(emitter.emit).toHaveBeenCalledWith(VOUCH_CREATED, {
        voucherId: 'u1',
        voucheeId: 'u2',
      });
    });

    it('behaves identically at a high vouch count (no threshold effect)', async () => {
      profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'them' });
      manager.count.mockResolvedValue(99);
      const result = await service.createVouch('u1', 'them');
      expect(result).toEqual({ vouchCount: 99 });
      expect(emitter.emit).toHaveBeenCalledTimes(1);
    });

    it('maps a 23505 that races past the pre-check to a 409', async () => {
      profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'them' });
      manager.insert.mockRejectedValue(uniqueViolation());
      await expect(service.createVouch('u1', 'them')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('withdrawVouch', () => {
    it('404s an unknown member', async () => {
      profiles.findOne.mockResolvedValue(null);
      await expect(service.withdrawVouch('u1', 'ghost')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('404s when there is no vouch to withdraw', async () => {
      profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'them' });
      (vouches as unknown as { delete: jest.Mock }).delete = jest
        .fn()
        .mockResolvedValue({ affected: 0 });
      await expect(service.withdrawVouch('u1', 'them')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('deletes the (voucher, vouchee) row and returns ok', async () => {
      profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'them' });
      const del = jest.fn().mockResolvedValue({ affected: 1 });
      (vouches as unknown as { delete: jest.Mock }).delete = del;
      await expect(service.withdrawVouch('u1', 'them')).resolves.toEqual({
        ok: true,
      });
      expect(del).toHaveBeenCalledWith({ voucherId: 'u1', voucheeId: 'u2' });
    });
  });

  describe('listVouchers', () => {
    it('404s an unknown member', async () => {
      profiles.findOne.mockResolvedValue(null);
      await expect(service.listVouchers('ghost')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('returns the full count and a bounded, mapped page', async () => {
      profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'them' });
      vouches.count.mockResolvedValue(42);
      vouches.find.mockResolvedValue([
        { voucherId: 'v1', note: 'ally', createdAt: new Date('2026-01-01') },
      ]);
      profiles.find.mockResolvedValue([
        { userId: 'v1', slug: 'val', firstName: 'Val', lastName: 'Reis' },
      ]);
      const res = await service.listVouchers('them', { limit: 10, offset: 5 });
      expect(vouches.find).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10, skip: 5 }),
      );
      expect(res.count).toBe(42); // total, not page length
      expect(res.vouchers).toEqual([
        {
          slug: 'val',
          firstName: 'Val',
          lastName: 'Reis',
          avatarUrl: null,
          note: 'ally',
          createdAt: new Date('2026-01-01'),
        },
      ]);
    });

    it('defaults to a bounded page when no pagination is supplied', async () => {
      profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'them' });
      await service.listVouchers('them');
      expect(vouches.find).toHaveBeenCalledWith(
        expect.objectContaining({ take: 20, skip: 0 }),
      );
    });
  });

  describe('listGiven', () => {
    it('returns a bounded, mapped page of vouches the user gave', async () => {
      vouches.find.mockResolvedValue([
        { voucheeId: 'w1', note: null, createdAt: new Date('2026-02-02') },
      ]);
      profiles.find.mockResolvedValue([
        { userId: 'w1', slug: 'wren', firstName: 'Wren', lastName: 'Sol' },
      ]);
      const res = await service.listGiven('u1', { limit: 5 });
      expect(vouches.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { voucherId: 'u1' },
          take: 5,
          skip: 0,
        }),
      );
      expect(res[0].slug).toBe('wren');
    });
  });
});
