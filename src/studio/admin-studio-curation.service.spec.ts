import { HttpException, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  AdminStudioCurationService,
  listsEveryIdOnce,
  normalizePickNote,
} from './admin-studio-curation.service';
import {
  StudioCuratedPick,
  StudioCuratedPickShelf,
} from './entities/studio-curated-pick.entity';
import { StudioReleaseStatus } from './entities/studio-release.entity';
import { StudioCatalogService } from './studio-catalog.service';
import { StudioReleaseCard } from './studio-response';

const STAFF_ID = 'd7100000-0000-4000-8000-000000000001';
const RELEASE_ID = 'd7100000-0000-4000-8000-000000000011';
const OTHER_RELEASE = 'd7100000-0000-4000-8000-000000000012';
const FIRST_PICK = 'd7100000-0000-4000-8000-000000000021';
const SECOND_PICK = 'd7100000-0000-4000-8000-000000000022';

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code?: string }).code;
  }
}

const pickRow = (
  id: string,
  shelf: string,
  position: number,
  releaseId: string,
  isListenable = true,
) => ({
  id,
  shelf,
  position,
  note: null,
  created_at: new Date('2026-10-13T09:00:00.000Z'),
  release_id: releaseId,
  release_status: isListenable ? 'published' : 'taken_down',
  is_listenable: isListenable,
});

describe('listsEveryIdOnce', () => {
  it('accepts every id once in any order and any letter case', () => {
    expect(
      listsEveryIdOnce(
        [FIRST_PICK, SECOND_PICK],
        [SECOND_PICK.toUpperCase(), FIRST_PICK],
      ),
    ).toBe(true);
  });

  it('refuses a repeated, a missing or a foreign id', () => {
    expect(
      listsEveryIdOnce([FIRST_PICK, SECOND_PICK], [FIRST_PICK, FIRST_PICK]),
    ).toBe(false);
    expect(listsEveryIdOnce([FIRST_PICK, SECOND_PICK], [FIRST_PICK])).toBe(
      false,
    );
    expect(listsEveryIdOnce([FIRST_PICK], [RELEASE_ID])).toBe(false);
  });
});

describe('normalizePickNote', () => {
  it('trims a note and stores an empty one as null', () => {
    expect(normalizePickNote('  Out tonight ')).toBe('Out tonight');
    expect(normalizePickNote('   ')).toBeNull();
    expect(normalizePickNote(null)).toBeNull();
    expect(normalizePickNote(undefined)).toBeNull();
  });
});

describe('AdminStudioCurationService', () => {
  let query: jest.Mock;
  let manager: {
    query: jest.Mock;
    findOne: jest.Mock;
    exists: jest.Mock;
    count: jest.Mock;
    delete: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let pickRepository: { findOne: jest.Mock; update: jest.Mock };
  let catalog: { cardsByReleaseId: jest.Mock };
  let service: AdminStudioCurationService;

  beforeEach(() => {
    query = jest.fn().mockResolvedValue([]);
    manager = {
      query: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue({
        id: RELEASE_ID,
        status: StudioReleaseStatus.Published,
      }),
      exists: jest.fn().mockResolvedValue(false),
      count: jest.fn().mockResolvedValue(0),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((_entity: unknown, row: object) => row),
      save: jest.fn((row: object) =>
        Promise.resolve({ ...row, id: FIRST_PICK }),
      ),
    };
    pickRepository = {
      findOne: jest.fn().mockResolvedValue({ id: FIRST_PICK }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    catalog = {
      cardsByReleaseId: jest.fn((releaseIds: string[]) =>
        Promise.resolve(
          new Map(
            releaseIds.map((releaseId) => [
              releaseId,
              { id: releaseId } as StudioReleaseCard,
            ]),
          ),
        ),
      ),
    };
    const dataSource = {
      query,
      transaction: jest.fn((work: (inner: EntityManager) => unknown) =>
        Promise.resolve(work(manager as unknown as EntityManager)),
      ),
      getRepository: jest.fn(() => pickRepository),
    };
    service = new AdminStudioCurationService(
      dataSource as unknown as DataSource,
      catalog as unknown as StudioCatalogService,
    );
  });

  describe('getCuration', () => {
    it('lists every pick of every shelf with its age and listenability', async () => {
      query.mockResolvedValue([
        pickRow(FIRST_PICK, 'featured', 1, RELEASE_ID),
        pickRow(SECOND_PICK, 'staff_picks', 1, OTHER_RELEASE, false),
      ]);

      const curation = await service.getCuration();

      expect(curation.featured).toEqual([
        {
          id: FIRST_PICK,
          shelf: 'featured',
          position: 1,
          note: null,
          createdAt: '2026-10-13T09:00:00.000Z',
          isListenable: true,
          release: { id: RELEASE_ID, status: 'published' },
        },
      ]);
      expect(curation.staffPicks[0]).toEqual(
        expect.objectContaining({
          id: SECOND_PICK,
          isListenable: false,
          release: { id: OTHER_RELEASE, status: 'taken_down' },
        }),
      );
      expect(curation.newThisWeek).toEqual([]);
      const [sql] = query.mock.calls[0] as [string];
      expect(sql).toContain('AS "is_listenable"');
      expect(sql).not.toContain('"blocks"');
    });
  });

  describe('searchReleases', () => {
    it('matches published releases by folded title or artist name, newest first, 20 at most', async () => {
      query.mockResolvedValue([{ id: RELEASE_ID, status: 'published' }]);

      const result = await service.searchReleases('  São_50%  ');

      const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain(`"release"."status" = 'published'`);
      expect(sql).toContain('translate(lower(');
      expect(sql).toContain(`ESCAPE '\\'`);
      expect(sql).toContain(
        'ORDER BY "release"."published_at" DESC, "release"."id" DESC',
      );
      expect(parameters).toEqual(['%São\\_50\\%%', 20]);
      expect(result.items).toEqual([{ id: RELEASE_ID, status: 'published' }]);
    });
  });

  describe('addPick', () => {
    beforeEach(() => {
      query.mockResolvedValue([
        pickRow(FIRST_PICK, 'staff_picks', 1, RELEASE_ID),
      ]);
    });

    it('appends to the shelf under a table lock, with a trimmed note and the staff member', async () => {
      manager.count.mockResolvedValue(3);

      await service.addPick(STAFF_ID, {
        shelf: 'staff_picks',
        releaseId: RELEASE_ID,
        note: '  A slow one ',
      });

      expect(manager.query.mock.calls[0]?.[0]).toBe(
        'LOCK TABLE "studio_curated_picks" IN SHARE ROW EXCLUSIVE MODE',
      );
      expect(manager.create).toHaveBeenCalledWith(StudioCuratedPick, {
        shelf: StudioCuratedPickShelf.StaffPicks,
        releaseId: RELEASE_ID,
        note: 'A slow one',
        position: 4,
        createdById: STAFF_ID,
      });
    });

    it('replaces the current featured pick in the same transaction', async () => {
      await service.addPick(STAFF_ID, {
        shelf: 'featured',
        releaseId: RELEASE_ID,
      });
      expect(manager.delete).toHaveBeenCalledWith(StudioCuratedPick, {
        shelf: StudioCuratedPickShelf.Featured,
      });
      expect(manager.count).not.toHaveBeenCalled();
      expect(manager.create).toHaveBeenCalledWith(
        StudioCuratedPick,
        expect.objectContaining({ position: 1, note: null }),
      );
    });

    it('refuses a thirteenth pick on a shelf', async () => {
      manager.count.mockResolvedValue(12);
      expect(
        await codeOf(
          service.addPick(STAFF_ID, {
            shelf: 'new_this_week',
            releaseId: RELEASE_ID,
          }),
        ),
      ).toBe('studio_curation_shelf_full');
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('refuses a release already on the shelf', async () => {
      manager.exists.mockResolvedValue(true);
      expect(
        await codeOf(
          service.addPick(STAFF_ID, {
            shelf: 'staff_picks',
            releaseId: RELEASE_ID,
          }),
        ),
      ).toBe('studio_curation_already_on_shelf');
    });

    it('refuses a release that is not published', async () => {
      manager.findOne.mockResolvedValue({
        id: RELEASE_ID,
        status: StudioReleaseStatus.Draft,
      });
      expect(
        await codeOf(
          service.addPick(STAFF_ID, {
            shelf: 'staff_picks',
            releaseId: RELEASE_ID,
          }),
        ),
      ).toBe('studio_curation_release_not_published');
    });

    it('answers 404 for an unknown release', async () => {
      manager.findOne.mockResolvedValue(null);
      await expect(
        service.addPick(STAFF_ID, {
          shelf: 'staff_picks',
          releaseId: RELEASE_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateNote', () => {
    it('stores the trimmed note, or null for an empty one', async () => {
      query.mockResolvedValue([
        pickRow(FIRST_PICK, 'staff_picks', 1, RELEASE_ID),
      ]);
      await service.updateNote(FIRST_PICK, { note: '   ' });
      expect(pickRepository.update).toHaveBeenCalledWith(
        { id: FIRST_PICK },
        { note: null },
      );
    });

    it('answers 404 for an unknown pick', async () => {
      pickRepository.findOne.mockResolvedValue(null);
      await expect(
        service.updateNote(FIRST_PICK, { note: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('removePick', () => {
    it('deletes the pick and closes the gap on its shelf in one statement', async () => {
      manager.findOne.mockResolvedValue({
        id: FIRST_PICK,
        shelf: StudioCuratedPickShelf.StaffPicks,
        position: 2,
      });
      await service.removePick(FIRST_PICK);
      expect(manager.delete).toHaveBeenCalledWith(StudioCuratedPick, {
        id: FIRST_PICK,
      });
      expect(manager.query).toHaveBeenLastCalledWith(
        `UPDATE "studio_curated_picks" SET "position" = "position" - 1 WHERE "shelf" = $1 AND "position" > $2`,
        ['staff_picks', 2],
      );
    });

    it('answers 404 for an unknown pick', async () => {
      manager.findOne.mockResolvedValue(null);
      await expect(service.removePick(FIRST_PICK)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('reorderShelf', () => {
    beforeEach(() => {
      manager.find.mockResolvedValue([{ id: FIRST_PICK }, { id: SECOND_PICK }]);
    });

    it('locks the picks table before it reads the shelf it reorders', async () => {
      await service.reorderShelf('staff_picks', [SECOND_PICK, FIRST_PICK]);
      const lockOrder = manager.query.mock.invocationCallOrder[0] ?? 0;
      const readOrder = manager.find.mock.invocationCallOrder[0] ?? 0;
      expect(manager.query.mock.calls[0]?.[0]).toBe(
        'LOCK TABLE "studio_curated_picks" IN SHARE ROW EXCLUSIVE MODE',
      );
      expect(lockOrder).toBeLessThan(readOrder);
    });

    it('defers the position constraint and writes 1..n in one statement', async () => {
      await service.reorderShelf('staff_picks', [
        SECOND_PICK.toUpperCase(),
        FIRST_PICK,
      ]);
      expect(manager.query).toHaveBeenCalledWith(
        `SET CONSTRAINTS "UQ_studio_curated_picks_shelf_position" DEFERRED`,
      );
      const [sql, parameters] = manager.query.mock.calls[2] as [
        string,
        unknown[],
      ];
      expect(sql).toContain('unnest($2::uuid[], $3::smallint[])');
      expect(parameters).toEqual([
        'staff_picks',
        [SECOND_PICK, FIRST_PICK],
        [1, 2],
      ]);
    });

    it('answers a mismatch for a repeated or a missing pick', async () => {
      expect(
        await codeOf(
          service.reorderShelf('staff_picks', [FIRST_PICK, FIRST_PICK]),
        ),
      ).toBe('studio_curation_order_mismatch');
      expect(
        await codeOf(service.reorderShelf('staff_picks', [FIRST_PICK])),
      ).toBe('studio_curation_order_mismatch');
    });
  });
});
