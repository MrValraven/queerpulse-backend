import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ConnectionsService } from '../connections/connections.service';
import { Profile, ProfileVisibility } from '../users/entities/profile.entity';
import { VouchService } from '../vouch/vouch.service';
import { SocialLink } from './entities/social-link.entity';
import { WorkItem } from './entities/work-item.entity';
import { ProfilesService } from './profiles.service';

describe('ProfilesService.getBySlug visibility', () => {
  let service: ProfilesService;
  let profiles: { findOne: jest.Mock };
  let socials: { find: jest.Mock };
  let work: { find: jest.Mock };
  let connections: { areConnected: jest.Mock };

  const profile = (overrides = {}): Profile =>
    ({
      userId: 'owner-1',
      slug: 'jo',
      firstName: 'Jo',
      lastName: 'Lee',
      pronouns: 'they/them',
      tagline: 'hi',
      bio: 'longform',
      location: 'Lisbon',
      avatarUrl: null,
      visibility: ProfileVisibility.Open,
      openTo: [],
      tags: [],
      ...overrides,
    }) as Profile;

  beforeEach(async () => {
    profiles = { findOne: jest.fn() };
    socials = { find: jest.fn().mockResolvedValue([]) };
    work = { find: jest.fn().mockResolvedValue([]) };
    connections = { areConnected: jest.fn().mockResolvedValue(false) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProfilesService,
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: getRepositoryToken(SocialLink), useValue: socials },
        { provide: getRepositoryToken(WorkItem), useValue: work },
        { provide: DataSource, useValue: {} },
        {
          provide: VouchService,
          useValue: {
            getVouchCount: jest.fn().mockResolvedValue(0),
            getVouchCounts: jest.fn().mockResolvedValue(new Map()),
          },
        },
        {
          provide: ConnectionsService,
          useValue: connections,
        },
      ],
    }).compile();
    service = module.get(ProfilesService);
  });

  it('404s an unknown slug', async () => {
    profiles.findOne.mockResolvedValue(null);
    await expect(service.getBySlug('nope', 'v1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('returns the full profile for an open profile to any viewer', async () => {
    profiles.findOne.mockResolvedValue(profile({ visibility: ProfileVisibility.Open }));
    const res = await service.getBySlug('jo', 'someone-else');
    expect(res.limited).toBe(false);
    expect((res as { bio: string }).bio).toBe('longform');
  });

  it('returns a limited card for a private profile to a non-owner', async () => {
    profiles.findOne.mockResolvedValue(profile({ visibility: ProfileVisibility.Private }));
    const res = await service.getBySlug('jo', 'someone-else');
    expect(res.limited).toBe(true);
    expect((res as Record<string, unknown>).bio).toBeUndefined();
  });

  it('returns the full profile to the owner regardless of visibility', async () => {
    profiles.findOne.mockResolvedValue(profile({ visibility: ProfileVisibility.Private }));
    const res = await service.getBySlug('jo', 'owner-1');
    expect(res.limited).toBe(false);
  });

  it('treats network as limited for a non-owner (until Phase 6 connections)', async () => {
    profiles.findOne.mockResolvedValue(profile({ visibility: ProfileVisibility.Network }));
    const res = await service.getBySlug('jo', 'someone-else');
    expect(res.limited).toBe(true);
  });

  it('returns the full network profile to an accepted connection', async () => {
    profiles.findOne.mockResolvedValue(
      profile({ visibility: ProfileVisibility.Network }),
    );
    connections.areConnected.mockResolvedValue(true);
    const res = await service.getBySlug('jo', 'someone-else');
    expect(res.limited).toBe(false);
  });
});
