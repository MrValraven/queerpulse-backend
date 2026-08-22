import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import { Profile } from '../users/entities/profile.entity';
import { RecognitionAward } from './entities/recognition-award.entity';
import { RecognitionLedgerEntry } from './entities/recognition-ledger-entry.entity';
import { RecognitionPerkClaim } from './entities/recognition-perk-claim.entity';
import { RecognitionStat } from './entities/recognition-stat.entity';
import { RecognitionAwardingService } from './recognition-awarding.service';
import { RecognitionService } from './recognition.service';
import { ProfilesService } from '../profiles/profiles.service';

describe('RecognitionService', () => {
  let service: RecognitionService;
  let statsRepo: { findOne: jest.Mock };
  let awardsRepo: { find: jest.Mock };
  let perkClaimsRepo: { find: jest.Mock };
  let ledgerRepo: { find: jest.Mock };
  let profilesRepo: { findOne: jest.Mock };
  let profilesService: { findBySlugOrThrow: jest.Mock };
  let awardingService: { gatherSignalsForUser: jest.Mock };

  beforeEach(async () => {
    statsRepo = { findOne: jest.fn().mockResolvedValue(null) };
    awardsRepo = { find: jest.fn().mockResolvedValue([]) };
    perkClaimsRepo = { find: jest.fn().mockResolvedValue([]) };
    ledgerRepo = { find: jest.fn().mockResolvedValue([]) };
    profilesRepo = { findOne: jest.fn() };
    profilesService = { findBySlugOrThrow: jest.fn() };
    // Non-null signals so buildRecognition's owner-gated fields (xpBreakdown,
    // xpLedger) populate — mirrors a real `includePerks: true` call.
    awardingService = {
      gatherSignalsForUser: jest.fn().mockResolvedValue({
        profileComplete: false,
        communitiesJoined: 0,
        personasPublished: 0,
        vouchCount: 0,
        connectionCount: 0,
        eventsAttended: 0,
        communityPosts: 0,
        endorsementCount: 0,
        workshopsTaught: 0,
        tenureDays: 0,
        verified: false,
        gettingStartedStepsDone: 0,
        gettingStartedComplete: false,
        listingsSaved: 0,
        articlesSaved: 0,
        workProfileComplete: false,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecognitionService,
        { provide: getRepositoryToken(RecognitionStat), useValue: statsRepo },
        { provide: getRepositoryToken(RecognitionAward), useValue: awardsRepo },
        {
          provide: getRepositoryToken(RecognitionPerkClaim),
          useValue: perkClaimsRepo,
        },
        {
          provide: getRepositoryToken(RecognitionLedgerEntry),
          useValue: ledgerRepo,
        },
        { provide: getRepositoryToken(Profile), useValue: profilesRepo },
        { provide: RecognitionAwardingService, useValue: awardingService },
        { provide: ProfilesService, useValue: profilesService },
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
        take: DEFAULT_LIST_LIMIT,
      });
      expect(dto.perks.availableCount).toBeGreaterThan(0);
      expect(dto.perks.groups.some((g) => g.label === 'Already claimed')).toBe(
        true,
      );
    });

    it('(owner-only) queries the XP ledger, newest first, alongside perks/signals', async () => {
      statsRepo.findOne.mockResolvedValue({ userId: 'u1', xp: 1000 });

      await service.getForUser('u1');

      expect(ledgerRepo.find).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        order: { createdAt: 'DESC' },
        take: DEFAULT_LIST_LIMIT,
      });
    });

    it('(I9) omits perks when includePerks=false, and skips the perk-claims and ledger queries entirely', async () => {
      statsRepo.findOne.mockResolvedValue({ userId: 'u1', xp: 1000 });

      const dto = await service.getForUser('u1', false);

      expect(perkClaimsRepo.find).not.toHaveBeenCalled();
      expect(ledgerRepo.find).not.toHaveBeenCalled();
      expect(dto.perks).toEqual({ availableCount: 0, groups: [], ladder: [] });
      expect(dto.xpLedger).toEqual([]);
      // Level/badges are unaffected by includePerks.
      expect(dto.level.level).toBe(4);
    });

    it('queries stats/awards/perk-claims scoped to the given userId', async () => {
      await service.getForUser('u2');
      expect(statsRepo.findOne).toHaveBeenCalledWith({
        where: { userId: 'u2' },
      });
      expect(awardsRepo.find).toHaveBeenCalledWith({
        where: { userId: 'u2' },
        take: DEFAULT_LIST_LIMIT,
      });
      expect(perkClaimsRepo.find).toHaveBeenCalledWith({
        where: { userId: 'u2' },
        take: DEFAULT_LIST_LIMIT,
      });
    });
  });

  describe('getBySlug', () => {
    it('resolves the slug through the visibility-gated profile read, then builds recognition for that user', async () => {
      profilesService.findBySlugOrThrow.mockResolvedValue({
        userId: 'u3',
        slug: 'jamie',
      });
      statsRepo.findOne.mockResolvedValue({ userId: 'u3', xp: 200 });

      const dto = await service.getBySlug('jamie', 'viewer-1', 'member');

      // (L10) the slug is resolved through the same block / hidden-from /
      // takedown gate the profile read applies, not a raw repository lookup.
      expect(profilesService.findBySlugOrThrow).toHaveBeenCalledWith(
        'jamie',
        'viewer-1',
        'member',
      );
      expect(statsRepo.findOne).toHaveBeenCalledWith({
        where: { userId: 'u3' },
      });
      expect(dto.level.level).toBe(2);
    });

    it('(I9) omits perks for the by-slug path — another member cannot see perk state', async () => {
      profilesService.findBySlugOrThrow.mockResolvedValue({
        userId: 'u3',
        slug: 'jamie',
      });
      statsRepo.findOne.mockResolvedValue({ userId: 'u3', xp: 1000 });
      perkClaimsRepo.find.mockResolvedValue([
        {
          userId: 'u3',
          perkKey: 'vouch-access',
          claimedAt: new Date('2026-01-01'),
        },
      ]);

      const dto = await service.getBySlug('jamie', 'viewer-1');

      // The perk-claims table is never even queried for a non-owner lookup.
      expect(perkClaimsRepo.find).not.toHaveBeenCalled();
      expect(dto.perks).toEqual({ availableCount: 0, groups: [], ladder: [] });
      // Level/badges (public) are still returned in full.
      expect(dto.level.level).toBe(4);
    });

    it('(L10) propagates the 404 when the viewer cannot see the profile (blocked, hidden, taken down, or nonexistent)', async () => {
      profilesService.findBySlugOrThrow.mockRejectedValue(
        new NotFoundException('Profile not found'),
      );
      await expect(service.getBySlug('ghost', 'viewer-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
