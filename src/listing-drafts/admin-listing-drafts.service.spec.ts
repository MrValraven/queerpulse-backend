import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PAGE_SIZE } from '../common/pagination';
import { Profile } from '../users/entities/profile.entity';
import { AdminListingDraftsService } from './admin-listing-drafts.service';
import { ListingDraft } from './entities/listing-draft.entity';

const at = new Date('2026-09-20T18:30:00.000Z');

const draftRow = (id: string, userId: string): ListingDraft => ({
  id,
  userId,
  payload: { step: 1, draft: { name: `Place ${id}`, path: 'suggest' } },
  resumeToken: `token-${id}`,
  createdAt: at,
  updatedAt: at,
});

describe('AdminListingDraftsService', () => {
  let service: AdminListingDraftsService;
  let queryBuilder: {
    orderBy: jest.Mock;
    addOrderBy: jest.Mock;
    skip: jest.Mock;
    take: jest.Mock;
    getManyAndCount: jest.Mock;
  };
  let profiles: { find: jest.Mock };
  let findOne: jest.Mock;

  beforeEach(async () => {
    queryBuilder = {
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn(),
    };
    profiles = { find: jest.fn() };
    findOne = jest.fn();

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AdminListingDraftsService,
        {
          provide: getRepositoryToken(ListingDraft),
          useValue: {
            createQueryBuilder: jest.fn(() => queryBuilder),
            findOne,
          },
        },
        { provide: getRepositoryToken(Profile), useValue: profiles },
      ],
    }).compile();
    service = moduleRef.get(AdminListingDraftsService);
  });

  it('pages newest-edited first with an id tie-break', async () => {
    queryBuilder.getManyAndCount.mockResolvedValue([[], 45]);
    const result = await service.list({ page: 3 });
    expect(queryBuilder.orderBy).toHaveBeenCalledWith(
      'draft.updated_at',
      'DESC',
    );
    expect(queryBuilder.addOrderBy).toHaveBeenCalledWith('draft.id', 'DESC');
    expect(queryBuilder.skip).toHaveBeenCalledWith(2 * PAGE_SIZE);
    expect(result).toEqual({
      items: [],
      total: 45,
      page: 3,
      pageSize: PAGE_SIZE,
    });
    expect(profiles.find).not.toHaveBeenCalled();
  });

  it('resolves every owner on the page in one lookup', async () => {
    queryBuilder.getManyAndCount.mockResolvedValue([
      [
        draftRow('a', 'user-1'),
        draftRow('b', 'user-1'),
        draftRow('c', 'user-2'),
      ],
      3,
    ]);
    profiles.find.mockResolvedValue([
      {
        userId: 'user-1',
        slug: 'marta',
        firstName: 'Marta',
        lastName: 'Fonseca',
        pronouns: null,
        avatarUrl: null,
        photoVisible: true,
      },
    ]);

    const result = await service.list();

    expect(profiles.find).toHaveBeenCalledTimes(1);
    expect(result.items.map((item) => item.owner?.userId ?? null)).toEqual([
      'user-1',
      'user-1',
      null,
    ]);
    expect(result.items[0]).toMatchObject({
      name: 'Place a',
      path: 'suggest',
      step: 1,
      owner: { slug: 'marta', firstName: 'Marta' },
    });
  });

  describe('getOne', () => {
    it('returns the summary, the owner and only the business half', async () => {
      findOne.mockResolvedValue({
        ...draftRow('d1', 'user-1'),
        payload: {
          step: 2,
          draft: { name: 'Tasca', hood: 'Graça', ownerBio: 'Private bio' },
        },
      });
      profiles.find.mockResolvedValue([
        {
          userId: 'user-1',
          slug: 'marta',
          firstName: 'Marta',
          lastName: 'Fonseca',
          pronouns: null,
          avatarUrl: null,
          photoVisible: true,
        },
      ]);

      const result = await service.getOne('d1');

      expect(findOne).toHaveBeenCalledWith({ where: { id: 'd1' } });
      expect(result).toMatchObject({
        id: 'd1',
        name: 'Tasca',
        step: 2,
        owner: { userId: 'user-1', slug: 'marta' },
        payload: { name: 'Tasca', hood: 'Graça' },
      });
      expect(result.payload).not.toHaveProperty('ownerBio');
    });

    it('404s once the draft is submitted or discarded', async () => {
      findOne.mockResolvedValue(null);
      await expect(service.getOne('gone')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(profiles.find).not.toHaveBeenCalled();
    });
  });
});
