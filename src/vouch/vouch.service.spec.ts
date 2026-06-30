import { BadRequestException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { Profile } from '../users/entities/profile.entity';
import { UsersService } from '../users/users.service';
import { Vouch } from './entities/vouch.entity';
import { VouchService } from './vouch.service';

describe('VouchService.createVouch', () => {
  let service: VouchService;
  let vouches: { findOne: jest.Mock; count: jest.Mock };
  let profiles: { findOne: jest.Mock };
  let users: { promoteToActive: jest.Mock };
  let manager: { insert: jest.Mock; count: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  beforeEach(async () => {
    vouches = { findOne: jest.fn().mockResolvedValue(null), count: jest.fn() };
    profiles = { findOne: jest.fn() };
    users = { promoteToActive: jest.fn().mockResolvedValue(true) };
    manager = {
      insert: jest.fn().mockResolvedValue(undefined),
      count: jest.fn(),
    };
    dataSource = {
      transaction: jest.fn().mockImplementation(async (cb) => cb(manager)),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VouchService,
        { provide: getRepositoryToken(Vouch), useValue: vouches },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: UsersService, useValue: users },
        { provide: DataSource, useValue: dataSource },
        { provide: ConfigService, useValue: { get: () => 2 } },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();
    service = module.get(VouchService);
  });

  it('rejects self-vouch', async () => {
    profiles.findOne.mockResolvedValue({ userId: 'u1', slug: 'me' });
    await expect(service.createVouch('u1', 'me')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a duplicate vouch', async () => {
    profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'them' });
    vouches.findOne.mockResolvedValue({ id: 'existing' });
    await expect(service.createVouch('u1', 'them')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('promotes the vouchee when the count reaches the threshold', async () => {
    profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'them' });
    manager.count.mockResolvedValue(2); // threshold is 2
    const result = await service.createVouch('u1', 'them', 'great person');
    expect(manager.insert).toHaveBeenCalled();
    expect(users.promoteToActive).toHaveBeenCalledWith('u2', { manager });
    expect(result).toEqual({ vouchCount: 2 });
  });

  it('does NOT promote below the threshold', async () => {
    profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'them' });
    manager.count.mockResolvedValue(1);
    await service.createVouch('u1', 'them');
    expect(users.promoteToActive).not.toHaveBeenCalled();
  });
});
