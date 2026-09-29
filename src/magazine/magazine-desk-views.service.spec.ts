import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MagazineDeskView } from './entities/magazine-desk-view.entity';
import { MagazineDeskViewsService } from './magazine-desk-views.service';

type ViewsRepositoryMock = {
  find: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  delete: jest.Mock;
};

function makeView(overrides: Partial<MagazineDeskView> = {}): MagazineDeskView {
  return {
    id: 'view-1',
    ownerId: 'editor-1',
    name: 'Close week',
    query: { focus: ['late'] },
    position: 0,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  } as MagazineDeskView;
}

describe('MagazineDeskViewsService', () => {
  let service: MagazineDeskViewsService;
  let views: ViewsRepositoryMock;

  beforeEach(async () => {
    views = {
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((entity: Partial<MagazineDeskView>) => ({
        id: 'view-new',
        ...entity,
      })),
      save: jest.fn((entity: unknown) => Promise.resolve(entity)),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MagazineDeskViewsService,
        { provide: getRepositoryToken(MagazineDeskView), useValue: views },
      ],
    }).compile();

    service = module.get(MagazineDeskViewsService);
  });

  describe('listViews', () => {
    it("reads only the caller's views, in position order", async () => {
      views.find.mockResolvedValue([makeView()]);

      const result = await service.listViews('editor-1');

      expect(views.find).toHaveBeenCalledWith({
        where: { ownerId: 'editor-1' },
        order: { position: 'ASC', createdAt: 'ASC' },
      });
      expect(result).toEqual([
        {
          id: 'view-1',
          name: 'Close week',
          query: { focus: ['late'] },
          position: 0,
        },
      ]);
    });
  });

  describe('createView', () => {
    it('appends after the last view with a validated query', async () => {
      views.find.mockResolvedValue([
        makeView(),
        makeView({ id: 'view-2', name: 'My queue', position: 3 }),
      ]);

      const result = await service.createView('editor-1', {
        name: 'Decks',
        query: { format: 'deck' },
      });

      expect(views.create).toHaveBeenCalledWith({
        ownerId: 'editor-1',
        name: 'Decks',
        query: { format: 'deck' },
        position: 4,
      });
      expect(result.position).toBe(4);
    });

    it('answers 409 on a name the owner already uses', async () => {
      views.find.mockResolvedValue([makeView()]);

      await expect(
        service.createView('editor-1', { name: 'Close week', query: {} }),
      ).rejects.toThrow(ConflictException);
      expect(views.save).not.toHaveBeenCalled();
    });

    it('answers 409 once the owner has 20 views', async () => {
      views.find.mockResolvedValue(
        Array.from({ length: 20 }, (_entry, position) =>
          makeView({
            id: `view-${position}`,
            name: `View ${position}`,
            position,
          }),
        ),
      );

      await expect(
        service.createView('editor-1', { name: 'One more', query: {} }),
      ).rejects.toThrow(ConflictException);
    });

    it('maps a lost unique-constraint race to the same 409', async () => {
      views.save.mockRejectedValue({
        code: '23505',
        constraint: 'UQ_magazine_desk_view_owner_name',
      });

      await expect(
        service.createView('editor-1', { name: 'Close week', query: {} }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('updateView', () => {
    it('answers 404 for a view the caller does not own', async () => {
      views.find.mockResolvedValue([makeView()]);

      await expect(
        service.updateView('editor-1', 'someone-elses-view', { name: 'Mine' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('renames and replaces the query', async () => {
      views.find.mockResolvedValue([makeView()]);

      const result = await service.updateView('editor-1', 'view-1', {
        name: 'Closing',
        query: { sort: 'stage' },
      });

      expect(result).toEqual({
        id: 'view-1',
        name: 'Closing',
        query: { sort: 'stage' },
        position: 0,
      });
    });

    it('answers 409 when renaming onto another view of the owner', async () => {
      views.find.mockResolvedValue([
        makeView(),
        makeView({ id: 'view-2', name: 'My queue', position: 1 }),
      ]);

      await expect(
        service.updateView('editor-1', 'view-2', { name: 'Close week' }),
      ).rejects.toThrow(ConflictException);
    });

    it('moves a view and renumbers the whole list', async () => {
      const first = makeView({ id: 'view-a', name: 'A', position: 0 });
      const second = makeView({ id: 'view-b', name: 'B', position: 1 });
      const third = makeView({ id: 'view-c', name: 'C', position: 5 });
      views.find.mockResolvedValue([first, second, third]);

      const result = await service.updateView('editor-1', 'view-c', {
        position: 0,
      });

      expect(result.position).toBe(0);
      expect(views.save).toHaveBeenCalledWith([third, first, second]);
      expect([first.position, second.position, third.position]).toEqual([
        1, 2, 0,
      ]);
    });
  });

  describe('deleteView', () => {
    it('deletes by id scoped to the owner', async () => {
      await service.deleteView('editor-1', 'view-1');

      expect(views.delete).toHaveBeenCalledWith({
        id: 'view-1',
        ownerId: 'editor-1',
      });
    });

    it('answers 404 when nothing of the caller matched', async () => {
      views.delete.mockResolvedValue({ affected: 0 });

      await expect(
        service.deleteView('editor-1', 'someone-elses-view'),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
