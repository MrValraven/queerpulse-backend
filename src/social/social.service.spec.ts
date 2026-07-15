import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ReportsService } from '../reports/reports.service';
import { Profile } from '../users/entities/profile.entity';
import { Block } from './entities/block.entity';
import { Mute } from './entities/mute.entity';
import { SocialService } from './social.service';

// A chainable query-builder stub covering both the read path (list +
// MemberLookup's slug resolution) and the `.insert().into().values()
// .orIgnore().execute()` idempotent-create path (mirrors
// `community-posts.service.spec.ts`'s `qbStub`/`insertQbStub`, merged since
// `createQueryBuilder` backs both here).
function qbStub(): Record<string, jest.Mock> {
  const qb: Record<string, jest.Mock> = {};
  for (const m of [
    'where',
    'andWhere',
    'innerJoin',
    'orderBy',
    'addOrderBy',
    'skip',
    'take',
    'insert',
    'into',
    'values',
    'orIgnore',
  ]) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getMany = jest.fn().mockResolvedValue([]);
  qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
  qb.execute = jest.fn().mockResolvedValue({ raw: [], generatedMaps: [] });
  return qb;
}

describe('SocialService', () => {
  let service: SocialService;
  let blocks: {
    createQueryBuilder: jest.Mock;
    findOneOrFail: jest.Mock;
    delete: jest.Mock;
    exist: jest.Mock;
  };
  let mutes: {
    createQueryBuilder: jest.Mock;
    findOneOrFail: jest.Mock;
    delete: jest.Mock;
    exist: jest.Mock;
  };
  let profiles: { find: jest.Mock; createQueryBuilder: jest.Mock };
  let reportsService: { create: jest.Mock };

  // Resolves any slug to a userId equal to the slug prefixed with `user-`,
  // via the same createQueryBuilder().getMany() path `MemberLookup` uses.
  function stubSlugResolution(slugToUserId: Record<string, string>): void {
    const qb = qbStub();
    qb.getMany.mockResolvedValue(
      Object.entries(slugToUserId).map(([slug, userId]) => ({
        slug,
        userId,
      })),
    );
    profiles.createQueryBuilder.mockReturnValue(qb);
  }

  beforeEach(async () => {
    blocks = {
      createQueryBuilder: jest.fn(() => qbStub()),
      findOneOrFail: jest.fn(),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      exist: jest.fn().mockResolvedValue(false),
    };
    mutes = {
      createQueryBuilder: jest.fn(() => qbStub()),
      findOneOrFail: jest.fn(),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      exist: jest.fn().mockResolvedValue(false),
    };
    profiles = {
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    reportsService = { create: jest.fn().mockResolvedValue({ id: 'r1' }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SocialService,
        { provide: getRepositoryToken(Block), useValue: blocks },
        { provide: getRepositoryToken(Mute), useValue: mutes },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: ReportsService, useValue: reportsService },
      ],
    }).compile();
    service = module.get(SocialService);
  });

  describe('listBlocks', () => {
    it('scopes the query to the caller and paginates', async () => {
      const qb = qbStub();
      blocks.createQueryBuilder.mockReturnValue(qb);
      const result = await service.listBlocks('me', 2);
      expect(blocks.createQueryBuilder).toHaveBeenCalledWith('block');
      expect(qb.where).toHaveBeenCalledWith('block.blockerId = :userId', {
        userId: 'me',
      });
      expect(result).toEqual({ items: [], total: 0, page: 2, pageSize: 20 });
    });

    it('resolves each blocked member via MemberLookup', async () => {
      const qb = qbStub();
      qb.getManyAndCount.mockResolvedValue([
        [
          {
            id: 'b1',
            blockerId: 'me',
            blockedId: 'them',
            reason: 'harassment',
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
          },
        ],
        1,
      ]);
      blocks.createQueryBuilder.mockReturnValue(qb);
      profiles.find.mockResolvedValue([
        { userId: 'them', slug: 'them', firstName: 'The', lastName: 'M' },
      ]);

      const result = await service.listBlocks('me');
      expect(result.items).toEqual([
        {
          id: 'b1',
          member: {
            slug: 'them',
            firstName: 'The',
            lastName: 'M',
            avatarUrl: undefined,
          },
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          reason: 'harassment',
        },
      ]);
    });
  });

  describe('blockMember', () => {
    it('404s an unknown slug', async () => {
      stubSlugResolution({});
      await expect(service.blockMember('me', 'ghost')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects blocking yourself', async () => {
      stubSlugResolution({ me: 'me' });
      await expect(service.blockMember('me', 'me')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('inserts idempotently (orIgnore) and returns the row', async () => {
      stubSlugResolution({ them: 'them' });
      const insertQb = qbStub();
      blocks.createQueryBuilder.mockReturnValue(insertQb);
      blocks.findOneOrFail.mockResolvedValue({
        id: 'b1',
        blockerId: 'me',
        blockedId: 'them',
        reason: 'spam',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      profiles.find.mockResolvedValue([
        { userId: 'them', slug: 'them', firstName: 'The', lastName: 'M' },
      ]);

      const result = await service.blockMember('me', 'them', {
        reason: 'spam',
      });
      expect(insertQb.values).toHaveBeenCalledWith({
        blockerId: 'me',
        blockedId: 'them',
        reason: 'spam',
      });
      expect(insertQb.orIgnore).toHaveBeenCalled();
      expect(blocks.findOneOrFail).toHaveBeenCalledWith({
        where: { blockerId: 'me', blockedId: 'them' },
      });
      expect(result.id).toBe('b1');
      expect(result.reason).toBe('spam');
    });

    it('files a companion report when alsoReport is true', async () => {
      stubSlugResolution({ them: 'them' });
      blocks.findOneOrFail.mockResolvedValue({
        id: 'b1',
        blockerId: 'me',
        blockedId: 'them',
        reason: 'harassment',
        createdAt: new Date(),
      });
      await expect(
        service.blockMember('me', 'them', {
          alsoReport: true,
          reason: 'harassment',
        }),
      ).resolves.toMatchObject({ id: 'b1' });
      expect(reportsService.create).toHaveBeenCalledWith('me', {
        subjectType: 'member',
        subjectId: 'them',
        reasonCode: 'other',
        detail: 'harassment',
      });
    });

    it('falls back to a default reason for the report when none is given', async () => {
      stubSlugResolution({ them: 'them' });
      blocks.findOneOrFail.mockResolvedValue({
        id: 'b1',
        blockerId: 'me',
        blockedId: 'them',
        reason: null,
        createdAt: new Date(),
      });
      await service.blockMember('me', 'them', { alsoReport: true });
      expect(reportsService.create).toHaveBeenCalledWith('me', {
        subjectType: 'member',
        subjectId: 'them',
        reasonCode: 'other',
        detail: 'Filed alongside a block.',
      });
    });

    it('does not file a report when alsoReport is not set', async () => {
      stubSlugResolution({ them: 'them' });
      blocks.findOneOrFail.mockResolvedValue({
        id: 'b1',
        blockerId: 'me',
        blockedId: 'them',
        reason: null,
        createdAt: new Date(),
      });
      await service.blockMember('me', 'them');
      expect(reportsService.create).not.toHaveBeenCalled();
    });
  });

  describe('unblockMember', () => {
    it('404s when there is nothing to unblock', async () => {
      stubSlugResolution({ them: 'them' });
      blocks.delete.mockResolvedValue({ affected: 0 });
      await expect(service.unblockMember('me', 'them')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('deletes the block row for the caller and slug', async () => {
      stubSlugResolution({ them: 'them' });
      await service.unblockMember('me', 'them');
      expect(blocks.delete).toHaveBeenCalledWith({
        blockerId: 'me',
        blockedId: 'them',
      });
    });
  });

  describe('getBlockStatus', () => {
    it('reports blocking without revealing anything else', async () => {
      stubSlugResolution({ them: 'them' });
      blocks.exist.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      await expect(service.getBlockStatus('me', 'them')).resolves.toEqual({
        blocking: true,
        blockedBy: false,
      });
    });

    it('reports blockedBy', async () => {
      stubSlugResolution({ them: 'them' });
      blocks.exist.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      await expect(service.getBlockStatus('me', 'them')).resolves.toEqual({
        blocking: false,
        blockedBy: true,
      });
    });

    it('allows checking your own slug without erroring', async () => {
      stubSlugResolution({ me: 'me' });
      await expect(service.getBlockStatus('me', 'me')).resolves.toEqual({
        blocking: false,
        blockedBy: false,
      });
    });
  });

  describe('listMutes', () => {
    it('scopes the query to the caller and paginates', async () => {
      const qb = qbStub();
      mutes.createQueryBuilder.mockReturnValue(qb);
      const result = await service.listMutes('me');
      expect(mutes.createQueryBuilder).toHaveBeenCalledWith('mute');
      expect(qb.where).toHaveBeenCalledWith('mute.muterId = :userId', {
        userId: 'me',
      });
      expect(result).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
    });
  });

  describe('muteMember', () => {
    it('404s an unknown slug', async () => {
      stubSlugResolution({});
      await expect(service.muteMember('me', 'ghost')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects muting yourself', async () => {
      stubSlugResolution({ me: 'me' });
      await expect(service.muteMember('me', 'me')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('inserts idempotently (orIgnore) and returns the row', async () => {
      stubSlugResolution({ them: 'them' });
      const insertQb = qbStub();
      mutes.createQueryBuilder.mockReturnValue(insertQb);
      mutes.findOneOrFail.mockResolvedValue({
        id: 'm1',
        muterId: 'me',
        mutedId: 'them',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      const result = await service.muteMember('me', 'them');
      expect(insertQb.values).toHaveBeenCalledWith({
        muterId: 'me',
        mutedId: 'them',
      });
      expect(result.id).toBe('m1');
    });
  });

  describe('unmuteMember', () => {
    it('404s when there is nothing to unmute', async () => {
      stubSlugResolution({ them: 'them' });
      mutes.delete.mockResolvedValue({ affected: 0 });
      await expect(service.unmuteMember('me', 'them')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('deletes the mute row for the caller and slug', async () => {
      stubSlugResolution({ them: 'them' });
      await service.unmuteMember('me', 'them');
      expect(mutes.delete).toHaveBeenCalledWith({
        muterId: 'me',
        mutedId: 'them',
      });
    });
  });
});
