import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Profile } from '../users/entities/profile.entity';
import { RecognitionAward } from './entities/recognition-award.entity';
import { RecognitionPerkClaim } from './entities/recognition-perk-claim.entity';
import { RecognitionStat } from './entities/recognition-stat.entity';
import { RecognitionService } from './recognition.service';

describe('RecognitionService', () => {
  let service: RecognitionService;
  let statsRepo: { findOne: jest.Mock };
  let awardsRepo: { find: jest.Mock };
  let perkClaimsRepo: { find: jest.Mock };
  let profilesRepo: { findOne: jest.Mock };

  beforeEach(async () => {
    statsRepo = { findOne: jest.fn().mockResolvedValue(null) };
    awardsRepo = { find: jest.fn().mockResolvedValue([]) };
    perkClaimsRepo = { find: jest.fn().mockResolvedValue([]) };
    profilesRepo = { findOne: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecognitionService,
        { provide: getRepositoryToken(RecognitionStat), useValue: statsRepo },
        { provide: getRepositoryToken(RecognitionAward), useValue: awardsRepo },
        {
          provide: getRepositoryToken(RecognitionPerkClaim),
          useValue: perkClaimsRepo,
        },
        { provide: getRepositoryToken(Profile), useValue: profilesRepo },
      ],
    }).compile();
    service = module.get(RecognitionService);
  });

  describe('getForUser', () => {
    it('a user with no recognition_stats row is treated as 0 XP (Level 1)', async () => {
      statsRepo.findOne.mockResolvedValue(null);
      const dto = await service.getForUser('u1');
      expect(statsRepo.findOne).toHaveBeenCalledWith({
        where: { userId: 'u1' },
      });
      expect(dto.level).toMatchObject({ level: 1, name: 'Newcomer', xp: 0 });
    });

    it('uses the stored xp total to compute level/badges/perks', async () => {
      // Cumulative level starts: L1=0, L2=200, L3=500, L4=950 — 1000 XP lands
      // just inside Level 4 (Familiar).
      statsRepo.findOne.mockResolvedValue({ userId: 'u1', xp: 1000 });
      awardsRepo.find.mockResolvedValue([
        { userId: 'u1', badgeKey: 'first-gathering', context: 'Pride Brunch' },
      ]);
      perkClaimsRepo.find.mockResolvedValue([
        {
          userId: 'u1',
          perkKey: 'vouch-access',
          claimedAt: new Date('2026-01-01'),
        },
      ]);

      const dto = await service.getForUser('u1');

      expect(dto.level.level).toBe(4);
      expect(dto.badges.earnedCount).toBe(1);
      expect(dto.badges.earned[0]).toMatchObject({
        key: 'first-gathering',
        context: 'Pride Brunch',
      });
      const claimedGroup = dto.perks.groups.find(
        (g) => g.label === 'Already claimed',
      );
      expect(claimedGroup?.perks).toHaveLength(1);
    });

    it('(I9) includes real perks by default (the `/me/recognition` path)', async () => {
      statsRepo.findOne.mockResolvedValue({ userId: 'u1', xp: 1000 });
      perkClaimsRepo.find.mockResolvedValue([
        {
          userId: 'u1',
          perkKey: 'vouch-access',
          claimedAt: new Date('2026-01-01'),
        },
      ]);

      const dto = await service.getForUser('u1');

      expect(perkClaimsRepo.find).toHaveBeenCalledWith({
        where: { userId: 'u1' },
      });
      expect(dto.perks.availableCount).toBeGreaterThan(0);
      expect(dto.perks.groups.some((g) => g.label === 'Already claimed')).toBe(
        true,
      );
    });

    it('(I9) omits perks when includePerks=false, and skips the perk-claims query entirely', async () => {
      statsRepo.findOne.mockResolvedValue({ userId: 'u1', xp: 1000 });

      const dto = await service.getForUser('u1', false);

      expect(perkClaimsRepo.find).not.toHaveBeenCalled();
      expect(dto.perks).toEqual({ availableCount: 0, groups: [], ladder: [] });
      // Level/badges are unaffected by includePerks.
      expect(dto.level.level).toBe(4);
    });

    it('queries stats/awards/perk-claims scoped to the given userId', async () => {
      await service.getForUser('u2');
      expect(statsRepo.findOne).toHaveBeenCalledWith({
        where: { userId: 'u2' },
      });
      expect(awardsRepo.find).toHaveBeenCalledWith({ where: { userId: 'u2' } });
      expect(perkClaimsRepo.find).toHaveBeenCalledWith({
        where: { userId: 'u2' },
      });
    });
  });

  describe('getBySlug', () => {
    it('resolves the slug to a userId via the Profile repository, then builds recognition for that user', async () => {
      profilesRepo.findOne.mockResolvedValue({ userId: 'u3', slug: 'jamie' });
      statsRepo.findOne.mockResolvedValue({ userId: 'u3', xp: 200 });

      const dto = await service.getBySlug('jamie');

      expect(profilesRepo.findOne).toHaveBeenCalledWith({
        where: { slug: 'jamie' },
      });
      expect(statsRepo.findOne).toHaveBeenCalledWith({
        where: { userId: 'u3' },
      });
      expect(dto.level.level).toBe(2);
    });

    it('(I9) omits perks for the by-slug path — another member cannot see perk state', async () => {
      profilesRepo.findOne.mockResolvedValue({ userId: 'u3', slug: 'jamie' });
      statsRepo.findOne.mockResolvedValue({ userId: 'u3', xp: 1000 });
      perkClaimsRepo.find.mockResolvedValue([
        {
          userId: 'u3',
          perkKey: 'vouch-access',
          claimedAt: new Date('2026-01-01'),
        },
      ]);

      const dto = await service.getBySlug('jamie');

      // The perk-claims table is never even queried for a non-owner lookup.
      expect(perkClaimsRepo.find).not.toHaveBeenCalled();
      expect(dto.perks).toEqual({ availableCount: 0, groups: [], ladder: [] });
      // Level/badges (public) are still returned in full.
      expect(dto.level.level).toBe(4);
    });

    it('throws NotFoundException when the slug does not resolve to a profile', async () => {
      profilesRepo.findOne.mockResolvedValue(null);
      await expect(service.getBySlug('ghost')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
