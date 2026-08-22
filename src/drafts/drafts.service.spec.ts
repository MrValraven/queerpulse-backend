import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DraftsService } from './drafts.service';
import { CreateDraftDto } from './dto/create-draft.dto';
import {
  Draft,
  DraftCategory,
  DraftKindVariant,
  DraftStatus,
} from './entities/draft.entity';

// A chainable query-builder stub whose terminal method resolves to a
// pre-seeded result set (mirrors `community-posts.service.spec.ts`'s
// `qbStub`).
function qbStub(rows: Draft[], total: number): Record<string, jest.Mock> {
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['where', 'orderBy', 'skip', 'take']) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getManyAndCount = jest.fn().mockResolvedValue([rows, total]);
  return qb;
}

const now = new Date('2026-07-15T12:00:00.000Z');

function makeDraft(overrides: Partial<Draft> = {}): Draft {
  return {
    id: 'd1',
    userId: 'u1',
    kind: 'JOB',
    payload: {
      kindVariant: DraftKindVariant.Job,
      title: 'Application · Communications Manager',
      desc: 'For Clube das Letras',
      progress: 60,
      ready: false,
      category: DraftCategory.Applications,
      status: DraftStatus.Draft,
      href: '/jobs',
      editedMinutes: 300,
      deadlineDays: 9,
      sortTitle: 'Application · Communications Manager',
      searchText: 'application communications manager',
    },
    version: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('DraftsService', () => {
  let service: DraftsService;
  let repo: {
    createQueryBuilder: jest.Mock;
    create: jest.Mock;
    insert: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    findOne: jest.Mock;
    remove: jest.Mock;
  };

  beforeEach(async () => {
    repo = {
      createQueryBuilder: jest.fn(),
      create: jest.fn((v: Partial<Draft>) => v as Draft),
      insert: jest.fn().mockResolvedValue({ identifiers: [] }),
      save: jest.fn((v: Partial<Draft>) =>
        Promise.resolve({ createdAt: now, updatedAt: now, ...v } as Draft),
      ),
      // The optimistic-concurrency claim (`WHERE version = :baseVersion`).
      // Defaults to "claimed"; a test that wants the 409 makes it affect 0.
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      findOne: jest.fn(),
      remove: jest.fn(),
    };
    // `update` runs its claim + save inside one transaction, resolving the
    // draft repository off the transactional manager — route it back to the
    // same mock so the assertions above still see every call.
    type TransactionManager = { getRepository: () => typeof repo };
    const transactionManager: TransactionManager = {
      getRepository: () => repo,
    };
    const dataSource = {
      transaction: jest.fn((run: (manager: TransactionManager) => unknown) =>
        run(transactionManager),
      ),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DraftsService,
        { provide: getRepositoryToken(Draft), useValue: repo },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = module.get(DraftsService);
  });

  describe('list', () => {
    it('returns the page-based envelope ({items,total,page,pageSize}), scoped to the caller', async () => {
      const draft = makeDraft();
      const qb = qbStub([draft], 1);
      repo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.list('u1', 1);

      expect(qb.where).toHaveBeenCalledWith('d.user_id = :userId', {
        userId: 'u1',
      });
      expect(qb.orderBy).toHaveBeenCalledWith('d.updated_at', 'DESC');
      expect(result).toEqual({
        items: [
          {
            id: 'd1',
            kind: 'JOB',
            kindVariant: DraftKindVariant.Job,
            title: 'Application · Communications Manager',
            desc: 'For Clube das Letras',
            progress: 60,
            ready: false,
            category: DraftCategory.Applications,
            status: DraftStatus.Draft,
            href: '/jobs',
            editedMinutes: 300,
            deadlineDays: 9,
            sortTitle: 'Application · Communications Manager',
            searchText: 'application communications manager',
            version: 0,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      });
    });

    it('normalizes an absent/invalid page to 1', async () => {
      const qb = qbStub([], 0);
      repo.createQueryBuilder.mockReturnValue(qb);

      await service.list('u1', undefined);
      expect(qb.skip).toHaveBeenCalledWith(0);

      await service.list('u1', 0);
      expect(qb.skip).toHaveBeenLastCalledWith(0);
    });
  });

  describe('create', () => {
    const dto: CreateDraftDto = {
      id: 'invite-1720000000',
      kind: 'JOB',
      kindVariant: DraftKindVariant.Job,
      title: 'Application · Communications Manager',
      desc: 'For Clube das Letras',
      progress: 60,
      ready: false,
      category: DraftCategory.Applications,
      status: DraftStatus.Draft,
      href: '/jobs',
      editedMinutes: 300,
      deadlineDays: 9,
      sortTitle: 'Application · Communications Manager',
      searchText: 'application communications manager',
    };

    it('persists the caller-supplied id under the caller, splitting kind (column) from the rest (payload jsonb)', async () => {
      const result = await service.create('u1', dto);

      expect(repo.create).toHaveBeenCalledWith({
        id: 'invite-1720000000',
        userId: 'u1',
        kind: 'JOB',
        payload: {
          kindVariant: DraftKindVariant.Job,
          title: 'Application · Communications Manager',
          desc: 'For Clube das Letras',
          progress: 60,
          ready: false,
          category: DraftCategory.Applications,
          status: DraftStatus.Draft,
          href: '/jobs',
          editedMinutes: 300,
          deadlineDays: 9,
          sortTitle: 'Application · Communications Manager',
          searchText: 'application communications manager',
        },
        version: 0,
      });
      // INSERT, never `save` — `save` on an existing primary key is an UPDATE,
      // which silently replaced a different draft's payload when an id was
      // reused.
      expect(repo.insert).toHaveBeenCalled();
      expect(repo.save).not.toHaveBeenCalled();
      expect(result.id).toBe('invite-1720000000');
      expect(result.kindVariant).toBe(DraftKindVariant.Job);
    });

    it('409s instead of overwriting when the caller reuses an existing draft id', async () => {
      repo.insert.mockRejectedValue({ code: '23505' });

      await expect(service.create('u1', dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('update', () => {
    it('404s when the draft does not exist for that caller', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        service.update('u1', 'missing', { progress: 90 }),
      ).rejects.toThrow(NotFoundException);
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { id: 'missing', userId: 'u1' },
      });
    });

    it('merges provided fields over the existing payload, leaving the rest untouched', async () => {
      repo.findOne.mockResolvedValue(makeDraft());

      const result = await service.update('u1', 'd1', {
        progress: 90,
        status: DraftStatus.Ready,
      });

      expect(result.progress).toBe(90);
      expect(result.status).toBe(DraftStatus.Ready);
      // untouched fields survive the merge
      expect(result.title).toBe('Application · Communications Manager');
      expect(result.deadlineDays).toBe(9);
    });

    it('an explicit `deadlineDays: null` clears the deadline (not treated as "not sent")', async () => {
      repo.findOne.mockResolvedValue(makeDraft());

      const result = await service.update('u1', 'd1', { deadlineDays: null });

      expect(result.deadlineDays).toBeNull();
    });

    it('omitting `deadlineDays` entirely leaves the existing value in place', async () => {
      repo.findOne.mockResolvedValue(makeDraft());

      const result = await service.update('u1', 'd1', { progress: 61 });

      expect(result.deadlineDays).toBe(9);
    });

    it('refuses a patch whose expectedVersion is behind the stored draft', async () => {
      repo.findOne.mockResolvedValue(makeDraft({ version: 4 }));

      await expect(
        service.update('u1', 'd1', { progress: 90, expectedVersion: 2 }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('refuses a patch that loses the row claim to a concurrent save', async () => {
      repo.findOne.mockResolvedValue(makeDraft({ version: 4 }));
      repo.update.mockResolvedValue({ affected: 0 });

      await expect(
        service.update('u1', 'd1', { progress: 90 }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('bumps the version so the next stale patch is refused', async () => {
      repo.findOne.mockResolvedValue(makeDraft({ version: 4 }));

      const result = await service.update('u1', 'd1', { progress: 90 });

      expect(repo.update).toHaveBeenCalledWith(
        { id: 'd1', userId: 'u1', version: 4 },
        { version: 5 },
      );
      expect(result.version).toBe(5);
    });

    it('updates the `kind` column when provided', async () => {
      repo.findOne.mockResolvedValue(makeDraft());

      const result = await service.update('u1', 'd1', { kind: 'PITCH' });

      expect(result.kind).toBe('PITCH');
    });
  });

  describe('remove', () => {
    it('404s when the draft does not exist for that caller', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.remove('u1', 'missing')).rejects.toThrow(
        NotFoundException,
      );
      expect(repo.remove).not.toHaveBeenCalled();
    });

    it('removes the draft scoped to the caller', async () => {
      const draft = makeDraft();
      repo.findOne.mockResolvedValue(draft);

      await service.remove('u1', 'd1');

      expect(repo.remove).toHaveBeenCalledWith(draft);
    });
  });
});
