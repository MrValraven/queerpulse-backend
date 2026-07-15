import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SelectQueryBuilder } from 'typeorm';
import { BlockFilterService } from './block-filter.service';
import { Block } from './entities/block.entity';
import { Mute } from './entities/mute.entity';

describe('BlockFilterService', () => {
  let service: BlockFilterService;
  let blocks: { exist: jest.Mock };
  let mutes: { exist: jest.Mock };

  beforeEach(async () => {
    blocks = { exist: jest.fn().mockResolvedValue(false) };
    mutes = { exist: jest.fn().mockResolvedValue(false) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BlockFilterService,
        { provide: getRepositoryToken(Block), useValue: blocks },
        { provide: getRepositoryToken(Mute), useValue: mutes },
      ],
    }).compile();
    service = module.get(BlockFilterService);
  });

  describe('isBlockedEitherWay', () => {
    it('is false for the same user (never blocks yourself)', async () => {
      await expect(service.isBlockedEitherWay('a', 'a')).resolves.toBe(false);
      expect(blocks.exist).not.toHaveBeenCalled();
    });

    it('queries both directions of the pair', async () => {
      await service.isBlockedEitherWay('a', 'b');
      expect(blocks.exist).toHaveBeenCalledWith({
        where: [
          { blockerId: 'a', blockedId: 'b' },
          { blockerId: 'b', blockedId: 'a' },
        ],
      });
    });

    it('is true when either direction has a row', async () => {
      blocks.exist.mockResolvedValue(true);
      await expect(service.isBlockedEitherWay('a', 'b')).resolves.toBe(true);
    });

    it('is false when neither direction has a row', async () => {
      blocks.exist.mockResolvedValue(false);
      await expect(service.isBlockedEitherWay('a', 'b')).resolves.toBe(false);
    });
  });

  describe('isMutedBy', () => {
    it('is false for the same user', async () => {
      await expect(service.isMutedBy('a', 'a')).resolves.toBe(false);
      expect(mutes.exist).not.toHaveBeenCalled();
    });

    it('is directional: checks only actor-muted-target, not the reverse', async () => {
      await service.isMutedBy('actor', 'target');
      expect(mutes.exist).toHaveBeenCalledWith({
        where: { muterId: 'actor', mutedId: 'target' },
      });
    });

    it('is true when actor has muted target', async () => {
      mutes.exist.mockResolvedValue(true);
      await expect(service.isMutedBy('actor', 'target')).resolves.toBe(true);
    });

    it('does not imply the reverse mute', async () => {
      // actor muted target (true), but target muting actor is a distinct row
      // this service was not asked about here.
      mutes.exist.mockResolvedValue(true);
      await service.isMutedBy('actor', 'target');
      expect(mutes.exist).toHaveBeenCalledWith({
        where: { muterId: 'actor', mutedId: 'target' },
      });
      expect(mutes.exist).not.toHaveBeenCalledWith({
        where: { muterId: 'target', mutedId: 'actor' },
      });
    });
  });

  describe('excludeBlocked', () => {
    function qbStub(): Record<string, jest.Mock> {
      const qb: Record<string, jest.Mock> = {};
      qb.andWhere = jest.fn().mockReturnValue(qb);
      return qb;
    }

    it('appends a NOT EXISTS predicate scoped to the actor and given column', () => {
      const qb = qbStub();
      const result = service.excludeBlocked(
        qb as unknown as SelectQueryBuilder<Record<string, unknown>>,
        'me',
        '"cp"."author_id"',
      );
      expect(qb.andWhere).toHaveBeenCalledTimes(1);
      const [sql, params] = qb.andWhere.mock.calls[0] as [string, unknown];
      expect(sql).toContain('NOT EXISTS');
      expect(sql).toContain('"cp"."author_id"');
      expect(sql).toContain(':blockFilterActorId');
      expect(params).toEqual({ blockFilterActorId: 'me' });
      expect(result).toBe(qb);
    });
  });
});
