import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SelectQueryBuilder } from 'typeorm';
import { HiddenFromMember } from './entities/hidden-from.entity';
import { HiddenFromService } from './hidden-from.service';

interface FakeRow {
  id: string;
  ownerId: string;
  hiddenFromUserId: string;
  createdAt: Date;
}

/**
 * In-memory fake standing in for the TypeORM repository so `hide`/`unhide`/
 * `isHiddenFrom`/`list` can be exercised end-to-end against real accumulated
 * state within a test — not just call-shape assertions — matching the
 * brief's TDD-style requirement: "hiding then searching as the hidden-from
 * viewer excludes the profile; searching as anyone else still finds it".
 * Mirrors `social.service.spec.ts`'s `qbStub` for the
 * `.insert().into().values().orIgnore().execute()` chain `hide` uses.
 */
function makeFakeRepo() {
  let rows: FakeRow[] = [];
  let nextId = 1;
  let pendingValues: { ownerId: string; hiddenFromUserId: string } | undefined;

  const insertQb: Record<string, jest.Mock> = {};
  for (const m of ['insert', 'into', 'orIgnore']) {
    insertQb[m] = jest.fn().mockReturnValue(insertQb);
  }
  insertQb.values = jest.fn(
    (v: { ownerId: string; hiddenFromUserId: string }) => {
      pendingValues = v;
      return insertQb;
    },
  );
  insertQb.execute = jest.fn(() => {
    if (
      pendingValues &&
      !rows.some(
        (r) =>
          r.ownerId === pendingValues!.ownerId &&
          r.hiddenFromUserId === pendingValues!.hiddenFromUserId,
      )
    ) {
      rows.push({
        id: `h${nextId++}`,
        ownerId: pendingValues.ownerId,
        hiddenFromUserId: pendingValues.hiddenFromUserId,
        createdAt: new Date(),
      });
    }
    return { raw: [], generatedMaps: [] };
  });

  return {
    createQueryBuilder: jest.fn(() => insertQb),
    delete: jest.fn(
      (criteria: { ownerId: string; hiddenFromUserId: string }) => {
        const before = rows.length;
        rows = rows.filter(
          (r) =>
            !(
              r.ownerId === criteria.ownerId &&
              r.hiddenFromUserId === criteria.hiddenFromUserId
            ),
        );
        return { affected: before - rows.length };
      },
    ),
    exist: jest.fn(
      (opts: { where: { ownerId: string; hiddenFromUserId: string } }) =>
        rows.some(
          (r) =>
            r.ownerId === opts.where.ownerId &&
            r.hiddenFromUserId === opts.where.hiddenFromUserId,
        ),
    ),
    find: jest.fn((opts: { where: { ownerId: string } }) =>
      rows.filter((r) => r.ownerId === opts.where.ownerId),
    ),
    _rows: () => rows,
  };
}

describe('HiddenFromService', () => {
  let service: HiddenFromService;
  let repo: ReturnType<typeof makeFakeRepo>;

  beforeEach(async () => {
    repo = makeFakeRepo();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HiddenFromService,
        { provide: getRepositoryToken(HiddenFromMember), useValue: repo },
      ],
    }).compile();
    service = module.get(HiddenFromService);
  });

  describe('hide + isHiddenFrom', () => {
    it('excludes the profile for the specific hidden-from viewer', async () => {
      await service.hide('owner', 'viewer-a');
      await expect(service.isHiddenFrom('owner', 'viewer-a')).resolves.toBe(
        true,
      );
    });

    it('still finds the profile for anyone else', async () => {
      await service.hide('owner', 'viewer-a');
      await expect(service.isHiddenFrom('owner', 'viewer-b')).resolves.toBe(
        false,
      );
    });

    it('is idempotent: hiding twice leaves exactly one row', async () => {
      await service.hide('owner', 'viewer-a');
      await service.hide('owner', 'viewer-a');
      expect(
        repo
          ._rows()
          .filter(
            (r) => r.ownerId === 'owner' && r.hiddenFromUserId === 'viewer-a',
          ),
      ).toHaveLength(1);
    });

    it('rejects hiding from yourself and inserts nothing', async () => {
      await expect(service.hide('me', 'me')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repo._rows()).toHaveLength(0);
    });
  });

  describe('unhide', () => {
    it('restores visibility: isHiddenFrom flips back to false', async () => {
      await service.hide('owner', 'viewer-a');
      await service.unhide('owner', 'viewer-a');
      await expect(service.isHiddenFrom('owner', 'viewer-a')).resolves.toBe(
        false,
      );
    });

    it('404s when there was nothing to unhide', async () => {
      await expect(service.unhide('owner', 'stranger')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('isHiddenFrom', () => {
    it('is false for the same user without querying the repo', async () => {
      await expect(service.isHiddenFrom('me', 'me')).resolves.toBe(false);
      expect(repo.exist).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it("returns only the owner's own hidden-from rows", async () => {
      await service.hide('owner', 'viewer-a');
      await service.hide('owner', 'viewer-b');
      await service.hide('someone-else', 'viewer-a');

      const list = await service.list('owner');
      expect(list.map((r) => r.hiddenFromUserId).sort()).toEqual([
        'viewer-a',
        'viewer-b',
      ]);
    });
  });

  describe('excludeHiddenFrom', () => {
    function qbStub(): Record<string, jest.Mock> {
      const qb: Record<string, jest.Mock> = {};
      qb.andWhere = jest.fn().mockReturnValue(qb);
      return qb;
    }

    it("appends a NOT EXISTS predicate scoped to the subject column and viewer, matching excludeBlocked's shape", () => {
      const qb = qbStub();
      const result = service.excludeHiddenFrom(
        qb as unknown as SelectQueryBuilder<Record<string, unknown>>,
        'viewer-1',
        '"p"."user_id"',
      );
      expect(qb.andWhere).toHaveBeenCalledTimes(1);
      const [sql, params] = qb.andWhere!.mock.calls[0] as [string, unknown];
      expect(sql).toContain('NOT EXISTS');
      expect(sql).toContain('"p"."user_id"');
      expect(sql).toContain(':hiddenFromFilterViewerId');
      expect(params).toEqual({ hiddenFromFilterViewerId: 'viewer-1' });
      expect(result).toBe(qb);
    });

    it('binds the subject column to owner_id and the viewer param to hidden_from_user_id (self-review: excludes when the CANDIDATE owner hid from the viewer, never the reverse)', () => {
      const qb = qbStub();
      service.excludeHiddenFrom(
        qb as unknown as SelectQueryBuilder<Record<string, unknown>>,
        'viewer-1',
        '"p"."user_id"',
      );
      const [sql] = qb.andWhere!.mock.calls[0] as [string, unknown];
      expect(sql).toMatch(/"owner_id"\s*=\s*"p"\."user_id"/);
      expect(sql).toContain(
        '"hidden_from_user_id" = :hiddenFromFilterViewerId',
      );
    });
  });
});
