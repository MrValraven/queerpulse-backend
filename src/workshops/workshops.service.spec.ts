import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import {
  Workshop,
  WorkshopHeroTint,
  WorkshopMode,
} from './entities/workshop.entity';
import { WorkshopsService } from './workshops.service';

// A chainable query-builder stub whose terminal methods resolve to empty
// results by default (mirrors `jobs.service.spec.ts`'s `qbStub`).
const qbStub = () => {
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['where', 'andWhere', 'orderBy', 'skip', 'take']) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
  return qb;
};

describe('WorkshopsService', () => {
  let service: WorkshopsService;
  let workshops: {
    findOne: jest.Mock;
    exists: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    remove: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let profiles: {
    findOne: jest.Mock;
    find: jest.Mock;
  };
  let blockFilter: { excludeHidden: jest.Mock };

  const baseWorkshopDto = {
    title: 'Risograph from nothing to a zine',
    blurb: 'Six Tuesday evenings at Editora Anjos.',
    cat: 'creative',
    mode: WorkshopMode.InPerson,
    weeks: 6,
    spotsTotal: 8,
    price: 180,
    about: ['Six structured 3-hour sessions.'],
  };

  beforeEach(async () => {
    workshops = {
      findOne: jest.fn(),
      exists: jest.fn().mockResolvedValue(false),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((v: object) => v),
      // Synthesizes generated columns so a mapper reading them off a `save()`
      // result never sees `undefined` (mirrors `jobs.service.spec.ts`).
      save: jest.fn((w: unknown) =>
        Promise.resolve({
          id: 'workshop-1',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          ...(w as object),
        }),
      ),
      remove: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    profiles = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
    };
    blockFilter = { excludeHidden: jest.fn((qb: unknown) => qb) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkshopsService,
        { provide: getRepositoryToken(Workshop), useValue: workshops },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: BlockFilterService, useValue: blockFilter },
      ],
    }).compile();
    service = module.get(WorkshopsService);
  });

  describe('create', () => {
    it('slugifies the title and defaults the unsupplied fields', async () => {
      const res = await service.create('host-1', baseWorkshopDto);

      expect(workshops.save).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'risograph-from-nothing-to-a-zine',
          hostId: 'host-1',
          titleEm: '',
          currency: 'EUR',
          heroTint: WorkshopHeroTint.Default,
          spotsFilled: 0,
          tiers: [],
          sessions: [],
          needs: [],
          pastWork: [],
          tags: [],
          location: { name: '', address: '', access: '' },
        }),
      );
      expect(res.slug).toBe('risograph-from-nothing-to-a-zine');
      expect(res.isHost).toBe(true);
    });

    it('stores price and tier amounts as numbers, never formatted strings', async () => {
      const res = await service.create('host-1', {
        ...baseWorkshopDto,
        tiers: [
          { label: 'Standard rate', amount: 180 },
          { label: 'Reduced', amount: 120, sliding: true },
        ],
      });

      expect(res.price).toBe(180);
      expect(res.currency).toBe('EUR');
      expect(res.tiers).toEqual([
        { label: 'Standard rate', amount: 180, sliding: false },
        { label: 'Reduced', amount: 120, sliding: true },
      ]);
    });

    it('retries with a fresh slug when the unique index races (23505)', async () => {
      workshops.save.mockRejectedValueOnce({ code: '23505' });

      const res = await service.create('host-1', baseWorkshopDto);

      expect(workshops.save).toHaveBeenCalledTimes(2);
      expect(res.slug).toBeDefined();
    });

    it('gives up with a 409 after exhausting slug attempts', async () => {
      workshops.save.mockRejectedValue({ code: '23505' });

      await expect(
        service.create('host-1', baseWorkshopDto),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('resolves the host MemberRef onto the response', async () => {
      profiles.findOne.mockResolvedValue({
        userId: 'host-1',
        slug: 'beatriz',
        firstName: 'Beatriz',
        lastName: 'Pinto',
        avatarUrl: null,
      });

      const res = await service.create('host-1', baseWorkshopDto);

      expect(res.host).toEqual({
        slug: 'beatriz',
        firstName: 'Beatriz',
        lastName: 'Pinto',
        avatarUrl: null,
      });
    });
  });

  describe('list', () => {
    it('applies block/mute filtering on the host column', async () => {
      await service.list('viewer-1', {});

      expect(blockFilter.excludeHidden).toHaveBeenCalledWith(
        expect.anything(),
        'viewer-1',
        '"w"."host_id"',
      );
    });

    it('filters by category when cat is supplied', async () => {
      const qb = qbStub();
      workshops.createQueryBuilder.mockReturnValue(qb);

      await service.list('viewer-1', { cat: 'craft' });

      expect(qb.andWhere).toHaveBeenCalledWith('w.cat = :cat', {
        cat: 'craft',
      });
    });

    it('returns the standard paginated envelope', async () => {
      const res = await service.list('viewer-1', {});

      expect(res).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
    });
  });

  describe('getBySlug', () => {
    it('404s an unknown slug', async () => {
      workshops.findOne.mockResolvedValue(null);
      await expect(
        service.getBySlug('nope', 'viewer-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('reports isHost false for a non-host viewer', async () => {
      workshops.findOne.mockResolvedValue({
        id: 'workshop-1',
        slug: 'x',
        hostId: 'host-1',
        tiers: [],
        sessions: [],
        needs: [],
        about: [],
        pastWork: [],
        tags: [],
        location: { name: '', address: '', access: '' },
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      const res = await service.getBySlug('x', 'viewer-1');
      expect(res.isHost).toBe(false);
    });
  });

  describe('update', () => {
    it('rejects a non-host (403)', async () => {
      workshops.findOne.mockResolvedValue({
        id: 'workshop-1',
        slug: 'x',
        hostId: 'host-1',
      });

      await expect(
        service.update('x', 'intruder', { title: 'Hijacked title' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(workshops.save).not.toHaveBeenCalled();
    });

    it('404s before the host check on an unknown slug', async () => {
      workshops.findOne.mockResolvedValue(null);
      await expect(
        service.update('nope', 'host-1', { title: 'New' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('applies only the supplied fields', async () => {
      workshops.findOne.mockResolvedValue({
        id: 'workshop-1',
        slug: 'x',
        hostId: 'host-1',
        title: 'Old title',
        cat: 'craft',
        price: 150,
        tiers: [],
        sessions: [],
        needs: [],
        about: [],
        pastWork: [],
        tags: [],
        location: { name: '', address: '', access: '' },
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      const res = await service.update('x', 'host-1', { price: 90 });

      expect(res.price).toBe(90);
      // Untouched fields survive the patch.
      expect(res.title).toBe('Old title');
      expect(res.cat).toBe('craft');
    });
  });

  describe('remove', () => {
    it('rejects a non-host (403)', async () => {
      workshops.findOne.mockResolvedValue({
        id: 'workshop-1',
        slug: 'x',
        hostId: 'host-1',
      });

      await expect(service.remove('x', 'intruder')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(workshops.remove).not.toHaveBeenCalled();
    });

    it('deletes the workshop for its host and returns nothing', async () => {
      const row = { id: 'workshop-1', slug: 'x', hostId: 'host-1' };
      workshops.findOne.mockResolvedValue(row);

      await expect(service.remove('x', 'host-1')).resolves.toBeUndefined();
      expect(workshops.remove).toHaveBeenCalledWith(row);
    });
  });
});
