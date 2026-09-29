import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, In, IsNull, QueryFailedError } from 'typeorm';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { Vouch } from './entities/vouch.entity';
import { VOUCH_CREATED } from './vouch.events';
import { VouchService } from './vouch.service';

// A 23505 (unique_violation) as TypeORM surfaces it.
const uniqueViolation = () =>
  new QueryFailedError('insert', [], {
    code: '23505',
  } as unknown as Error);

/**
 * The explicit (not index-signature) shape of a `vouches.createQueryBuilder`
 * mock, so a caller can do `builder.getMany.mockResolvedValue(...)` without
 * `noUncheckedIndexedAccess` treating every property as possibly `undefined`.
 */
type VouchesQueryBuilderMock = {
  where: jest.Mock;
  andWhere: jest.Mock;
  select: jest.Mock;
  addSelect: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  groupBy: jest.Mock;
  offset: jest.Mock;
  limit: jest.Mock;
  getCount: jest.Mock;
  getMany: jest.Mock;
  getRawMany: jest.Mock;
};

/**
 * A standalone `vouches.createQueryBuilder('v')` mock, independent of every
 * other one. Most tests in this file share ONE builder object across every
 * call `listVouchers` makes (count, the named-id scan, the page), which is
 * enough when a test only checks that some clause was applied somewhere. A
 * test that needs to prove WHICH of those three queries a clause landed on
 * (the roster's visibility filter belongs on the page query alone) instead
 * gives `vouches.createQueryBuilder` a `mockImplementation` that returns one
 * of these per call, in the fixed order `listVouchers` issues them: count,
 * then the id scan, then the page.
 */
function newVouchesQueryBuilder(): VouchesQueryBuilderMock {
  return {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    offset: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getCount: jest.fn(),
    getMany: jest.fn(),
    getRawMany: jest.fn(),
  };
}

describe('VouchService', () => {
  let service: VouchService;
  let vouches: {
    findOne: jest.Mock;
    find: jest.Mock;
    count: jest.Mock;
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  // The builder every "vouches this member has RECEIVED" read now goes
  // through (`activeVouchesReceivedBy`): withdrawn rows and block-severed rows
  // are both excluded in SQL, so the count and the roster can never disagree.
  let vouchesQuery: Record<string, jest.Mock>;
  let activeVouchesCount: number;
  let activeVouchesPage: unknown[];
  // What `getNamedVoucherIds`' raw query returns: the target's WHOLE active,
  // non-anonymous voucher pool, every page of it, which
  // `resolveVisibleNamedVoucherIds` resolves visibility for up front, before
  // `listVouchers` paginates.
  let namedVoucherRows: { voucher_id: string }[];
  let blockFilter: { isBlockedEitherWay: jest.Mock; excludeBlocked: jest.Mock };
  // The viewer-bound `ProfilesService.visibleMemberIds` the controller hands
  // `listVouchers` (ENG-436). Everyone is visible by default.
  let visibleMemberIds: jest.Mock<Promise<Set<string>>, [string[]]>;
  let profiles: {
    findOne: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let manager: {
    findOne: jest.Mock;
    insert: jest.Mock;
    update: jest.Mock;
    count: jest.Mock;
    increment: jest.Mock;
    decrement: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };
  let emitter: { emit: jest.Mock };
  // What the daily-cap query returns. `createVouch` counts
  // COALESCE(reactivated_at, created_at) through a query builder, so it can no
  // longer be driven by `manager.count`.
  let vouchesGivenToday: number;

  beforeEach(async () => {
    activeVouchesCount = 0;
    activeVouchesPage = [];
    namedVoucherRows = [];
    vouchesQuery = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getCount: jest.fn(() => Promise.resolve(activeVouchesCount)),
      getMany: jest.fn(() => Promise.resolve(activeVouchesPage)),
      getRawMany: jest.fn(() => Promise.resolve(namedVoucherRows)),
    };
    vouches = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => vouchesQuery),
    };
    blockFilter = {
      isBlockedEitherWay: jest.fn().mockResolvedValue(false),
      // Mirrors the real signature: it appends a predicate and hands the
      // builder back for chaining.
      excludeBlocked: jest.fn((query: unknown) => query),
    };
    visibleMemberIds = jest.fn((userIds: string[]) =>
      Promise.resolve(new Set(userIds)),
    );
    profiles = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      // `createVouch` resolves the vouchee through an ACTIVE-user join, so it
      // goes via a query builder while `withdrawVouch` still uses `findOne`
      // (`listVouchers` takes a resolved profile). Delegating `getOne()` to the same `findOne` mock keeps every
      // `profiles.findOne.mockResolvedValue(...)` below meaningful for both.
      createQueryBuilder: jest.fn(() => ({
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn(() => profiles.findOne() as Promise<unknown>),
      })),
    };
    vouchesGivenToday = 0;
    manager = {
      findOne: jest.fn().mockResolvedValue(null), // the pessimistic-lock read
      insert: jest.fn().mockResolvedValue(undefined),
      // Every in-transaction update is a CONDITIONAL claim whose `affected` the
      // service reads to decide whether it won the race.
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      count: jest.fn().mockResolvedValue(0),
      // The denormalized profiles.vouch_count is kept in sync inside the same
      // transaction (see B3): createVouch increments, withdrawVouch decrements.
      increment: jest.fn().mockResolvedValue(undefined),
      decrement: jest.fn().mockResolvedValue(undefined),
      // The daily-cap count.
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn(() => Promise.resolve(vouchesGivenToday)),
      })),
    };
    dataSource = {
      transaction: jest
        .fn()
        .mockImplementation(
          (
            runInTransaction: (
              entityManager: typeof manager,
            ) => Promise<unknown>,
          ) => runInTransaction(manager),
        ),
    };
    emitter = { emit: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VouchService,
        { provide: getRepositoryToken(Vouch), useValue: vouches },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: DataSource, useValue: dataSource },
        { provide: EventEmitter2, useValue: emitter },
        { provide: BlockFilterService, useValue: blockFilter },
      ],
    }).compile();
    service = module.get(VouchService);
  });

  describe('createVouch', () => {
    it('404s an unknown member', async () => {
      profiles.findOne.mockResolvedValue(null);
      await expect(service.createVouch('u1', 'ghost')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects self-vouch', async () => {
      profiles.findOne.mockResolvedValue({ userId: 'u1', slug: 'me' });
      await expect(service.createVouch('u1', 'me')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('403s when a block runs either way between the two members', async () => {
      profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'them' });
      blockFilter.isBlockedEitherWay.mockResolvedValue(true);
      await expect(service.createVouch('u1', 'them')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(blockFilter.isBlockedEitherWay).toHaveBeenCalledWith('u1', 'u2');
      // Refused before any write, so no row, no counter bump, no notification.
      expect(manager.insert).not.toHaveBeenCalled();
      expect(manager.increment).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('rejects a duplicate vouch found by the pre-check', async () => {
      profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'them' });
      vouches.findOne.mockResolvedValue({ id: 'existing', withdrawnAt: null });
      await expect(service.createVouch('u1', 'them')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('locks the vouchee row before counting', async () => {
      profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'them' });
      manager.count.mockResolvedValue(1);
      await service.createVouch('u1', 'them');
      expect(manager.findOne).toHaveBeenCalledWith(User, {
        where: { id: 'u2' },
        lock: { mode: 'pessimistic_write' },
      });
    });

    it('trims the note and stores empty/whitespace as null', async () => {
      profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'them' });
      await service.createVouch('u1', 'them', { note: '  great person  ' });
      expect(manager.insert).toHaveBeenCalledWith(
        Vouch,
        expect.objectContaining({ note: 'great person' }),
      );

      manager.insert.mockClear();
      await service.createVouch('u1', 'them', { note: '   ' });
      expect(manager.insert).toHaveBeenCalledWith(
        Vouch,
        expect.objectContaining({ note: null }),
      );
    });

    // Vouches are a trust/recognition signal only — they no longer gate
    // membership. There is no threshold, no promotion, and no USER_PROMOTED
    // here; the vouch count is returned for display and nothing else.
    it('returns the vouch count and emits only VOUCH_CREATED', async () => {
      profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'them' });
      manager.count.mockResolvedValue(2);
      const result = await service.createVouch('u1', 'them');
      expect(result).toEqual({ vouchCount: 2 });
      expect(emitter.emit).toHaveBeenCalledTimes(1);
      expect(emitter.emit).toHaveBeenCalledWith(VOUCH_CREATED, {
        voucherId: 'u1',
        voucheeId: 'u2',
      });
    });

    it('behaves identically at a high vouch count (no threshold effect)', async () => {
      profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'them' });
      // The daily-cap pre-check is its own query (`vouchesGivenToday`, kept
      // under the limit); `manager.count` is only the post-insert
      // active-vouchCount tally asserted here. Two unrelated counts (COM-26).
      vouchesGivenToday = 2;
      manager.count.mockResolvedValue(99);
      const result = await service.createVouch('u1', 'them');
      expect(result).toEqual({ vouchCount: 99 });
      expect(emitter.emit).toHaveBeenCalledTimes(1);
    });

    it('maps a 23505 that races past the pre-check to a 409', async () => {
      profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'them' });
      manager.insert.mockRejectedValue(uniqueViolation());
      await expect(service.createVouch('u1', 'them')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    // COM-26: a daily cap alongside the existing per-minute @Throttle, so a
    // member can't dilute vouching as a trust signal by vouching for hundreds
    // of people over time.
    describe('daily vouch cap', () => {
      it("locks the voucher's own row before counting vouches given today", async () => {
        profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'them' });
        await service.createVouch('u1', 'them');
        expect(manager.findOne).toHaveBeenCalledWith(User, {
          where: { id: 'u1' },
          lock: { mode: 'pessimistic_write' },
        });
      });

      it('allows the vouch when under the daily limit', async () => {
        profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'them' });
        vouchesGivenToday = 19;
        manager.count.mockResolvedValue(1);
        await expect(service.createVouch('u1', 'them')).resolves.toBeDefined();
        expect(manager.insert).toHaveBeenCalled();
      });

      it('rejects with 403 once the daily limit is reached, without inserting', async () => {
        profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'them' });
        vouchesGivenToday = 20;
        await expect(service.createVouch('u1', 'them')).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        expect(manager.insert).not.toHaveBeenCalled();
        expect(emitter.emit).not.toHaveBeenCalled();
      });

      it('carries the VOUCH_DAILY_LIMIT code with the unchanged message and status', async () => {
        profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'them' });
        vouchesGivenToday = 20;
        const error: unknown = await service
          .createVouch('u1', 'them')
          .catch((thrown: unknown) => thrown);
        expect(error).toBeInstanceOf(ForbiddenException);
        const forbidden = error as ForbiddenException;
        expect(forbidden.getStatus()).toBe(403);
        expect(forbidden.getResponse()).toEqual({
          statusCode: 403,
          error: 'Forbidden',
          message:
            'You can vouch for up to 20 members per day. Try again tomorrow.',
          code: 'VOUCH_DAILY_LIMIT',
        });
      });

      // The cap counts COALESCE(reactivated_at, created_at), so a
      // withdraw-and-re-vouch cycle costs a slot instead of being free.
      it('counts reactivations, not just first-time vouches', async () => {
        profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'them' });
        vouchesGivenToday = 20;
        vouches.findOne.mockResolvedValue({
          id: 'v9',
          withdrawnAt: new Date('2026-01-01'),
        });
        await expect(service.createVouch('u1', 'them')).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        expect(manager.update).not.toHaveBeenCalled();
      });

      it('counts by COALESCE(reactivated_at, created_at) for this voucher', async () => {
        profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'them' });
        const builder = {
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getCount: jest.fn().mockResolvedValue(0),
        };
        manager.createQueryBuilder.mockReturnValue(builder);

        await service.createVouch('u1', 'them');

        expect(builder.where).toHaveBeenCalledWith('v.voucherId = :voucherId', {
          voucherId: 'u1',
        });
        expect(builder.andWhere).toHaveBeenCalledWith(
          'COALESCE(v.reactivatedAt, v.createdAt) >= :dayStart',
          expect.objectContaining({ dayStart: expect.any(Date) as unknown }),
        );
      });
    });
  });

  describe('createVouch relationships + anonymous', () => {
    it('persists relationships and anonymous on insert', async () => {
      profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'target' });
      vouches.findOne.mockResolvedValue(null); // no existing row
      manager.count.mockResolvedValue(1);
      await service.createVouch('u1', 'target', {
        note: 'we shipped together',
        relationships: ['collaborated', 'friends'],
        anonymous: true,
      });
      expect(manager.insert).toHaveBeenCalledWith(
        Vouch,
        expect.objectContaining({
          voucherId: 'u1',
          voucheeId: 'u2',
          note: 'we shipped together',
          relationships: ['collaborated', 'friends'],
          anonymous: true,
        }),
      );
    });

    it('de-dupes relationships and drops unknown values', async () => {
      profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'target' });
      vouches.findOne.mockResolvedValue(null);
      manager.count.mockResolvedValue(1);
      await service.createVouch('u1', 'target', {
        relationships: ['friends', 'friends', 'nonsense' as never, 'group'],
      });
      expect(manager.insert).toHaveBeenCalledWith(
        Vouch,
        expect.objectContaining({ relationships: ['friends', 'group'] }),
      );
    });

    it('un-withdraws an existing withdrawn pair instead of 409', async () => {
      profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'target' });
      vouches.findOne.mockResolvedValue({
        id: 'v9',
        voucherId: 'u1',
        voucheeId: 'u2',
        withdrawnAt: new Date('2026-01-01'),
      });
      manager.count.mockResolvedValue(3);
      await service.createVouch('u1', 'target', {
        relationships: ['friends'],
      });
      // The re-vouch/un-withdraw path updates the row via the transaction's
      // EntityManager (not the `vouches` repository), so it commits or rolls
      // back atomically with the pessimistic-lock read and the count below.
      // Conditional on the row still being withdrawn, so two concurrent
      // re-vouches can't both "reactivate" it and both increment vouch_count.
      expect(manager.update).toHaveBeenCalledWith(
        Vouch,
        { id: 'v9', withdrawnAt: expect.anything() as unknown },
        expect.objectContaining({
          withdrawnAt: null,
          // Stamped so the daily cap sees the reinstatement.
          reactivatedAt: expect.any(Date) as unknown,
          relationships: ['friends'],
        }),
      );
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it('409s when an ACTIVE vouch already exists', async () => {
      profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'target' });
      vouches.findOne.mockResolvedValue({
        id: 'v1',
        voucherId: 'u1',
        voucheeId: 'u2',
        withdrawnAt: null,
      });
      await expect(
        service.createVouch('u1', 'target', {}),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('withdrawVouch', () => {
    it('404s an unknown member', async () => {
      profiles.findOne.mockResolvedValue(null);
      await expect(service.withdrawVouch('u1', 'ghost')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('withdrawVouch (soft-delete)', () => {
    it('sets withdrawnAt instead of deleting', async () => {
      profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'target' });
      vouches.findOne.mockResolvedValue({
        id: 'v1',
        voucherId: 'u1',
        voucheeId: 'u2',
        withdrawnAt: null,
      });
      await expect(service.withdrawVouch('u1', 'target')).resolves.toEqual({
        ok: true,
      });
      // The soft-delete now runs inside the transaction via the EntityManager
      // (so the withdraw and the denormalized-counter decrement commit or roll
      // back atomically), not through the `vouches` repository.
      // Conditional on the row still being active, so a double-click can't
      // decrement vouch_count twice.
      expect(manager.update).toHaveBeenCalledWith(
        Vouch,
        { id: 'v1', withdrawnAt: expect.anything() as unknown },
        expect.objectContaining({ withdrawnAt: expect.any(Date) as unknown }),
      );
      // And the denormalized profiles.vouch_count is decremented in the same
      // transaction (mirror of createVouch's increment — see B3).
      expect(manager.decrement).toHaveBeenCalledWith(
        Profile,
        { userId: 'u2' },
        'vouchCount',
        1,
      );
      expect(vouches.update).not.toHaveBeenCalled();
    });

    it('404s when there is no active vouch to withdraw', async () => {
      profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'target' });
      vouches.findOne.mockResolvedValue(null);
      await expect(
        service.withdrawVouch('u1', 'target'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // `listVouchers` takes the target already resolved: the controller runs the
  // slug through `ProfilesService.findBySlugOrThrow` first (ENG-436), so the
  // slug-level gates (status, block, hidden-from, 24h hide, takedown) are
  // covered by that method's spec and the 404 never reaches this service.
  const target = (overrides: Partial<Profile> = {}): Profile =>
    ({
      userId: 'u2',
      slug: 'them',
      vouchersVisible: true,
      ...overrides,
    }) as Profile;

  describe('listVouchers excludes withdrawn and block-severed rows', () => {
    it('filters count and rows by withdrawnAt IS NULL', async () => {
      await service.listVouchers(
        target(),
        'some-other-viewer',
        visibleMemberIds,
      );
      expect(vouchesQuery.andWhere).toHaveBeenCalledWith(
        'v.withdrawnAt IS NULL',
      );
      expect(vouchesQuery.getCount).toHaveBeenCalled();
      expect(vouchesQuery.getMany).toHaveBeenCalled();
    });

    it('applies the block severance to the count, the named-voucher-id resolution AND the page, target-relative', async () => {
      await service.listVouchers(
        target(),
        'some-other-viewer',
        visibleMemberIds,
      );
      // Three builders, each severed against the TARGET: a block is mutual,
      // so the vouch stops existing for everyone. The count, the whole-roster
      // named-voucher-id read `resolveVisibleNamedVoucherIds` resolves
      // visibility for up front (ENG-436), and the paginated page itself.
      expect(blockFilter.excludeBlocked).toHaveBeenCalledTimes(3);
      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        vouchesQuery,
        'u2',
        '"v"."voucher_id"',
      );
    });
  });

  describe('listVouchers', () => {
    it('reads the roster of the resolved target and never looks the slug up again', async () => {
      await service.listVouchers(
        target(),
        'some-other-viewer',
        visibleMemberIds,
      );
      expect(profiles.findOne).not.toHaveBeenCalled();
      expect(vouchesQuery.where).toHaveBeenCalledWith(
        'v.voucheeId = :voucheeId',
        { voucheeId: 'u2' },
      );
    });

    it('returns the full count and a bounded, mapped page', async () => {
      activeVouchesCount = 42;
      namedVoucherRows = [{ voucher_id: 'v1' }];
      activeVouchesPage = [
        { voucherId: 'v1', note: 'ally', createdAt: new Date('2026-01-01') },
      ];
      profiles.find.mockResolvedValue([
        {
          userId: 'v1',
          slug: 'val',
          firstName: 'Val',
          lastName: 'Reis',
          photoVisible: true,
        },
      ]);
      const res = await service.listVouchers(
        target(),
        'some-other-viewer',
        visibleMemberIds,
        {
          limit: 10,
          offset: 5,
        },
      );
      expect(vouchesQuery.offset).toHaveBeenCalledWith(5);
      expect(vouchesQuery.limit).toHaveBeenCalledWith(10);
      expect(res.count).toBe(42); // total, not page length
      expect(res.vouchers).toEqual([
        {
          slug: 'val',
          firstName: 'Val',
          lastName: 'Reis',
          avatarUrl: null,
          note: 'ally',
          createdAt: new Date('2026-01-01'),
          anonymous: false,
          relationships: null,
        },
      ]);
    });

    it("honours the voucher's own photoVisible toggle", async () => {
      activeVouchesCount = 1;
      namedVoucherRows = [{ voucher_id: 'v1' }];
      activeVouchesPage = [
        { voucherId: 'v1', note: null, createdAt: new Date('2026-01-01') },
      ];
      profiles.find.mockResolvedValue([
        {
          userId: 'v1',
          slug: 'val',
          firstName: 'Val',
          lastName: 'Reis',
          avatarUrl: 'uploads/val.jpg',
          photoVisible: false,
        },
      ]);
      const res = await service.listVouchers(
        target(),
        'some-other-viewer',
        visibleMemberIds,
      );
      // The name still identifies the voucher (that is what a named vouch is);
      // the face is the thing they turned off.
      expect(res.vouchers[0]!.slug).toBe('val');
      expect(res.vouchers[0]!.avatarUrl).toBeNull();
    });

    it('shields anonymous vouchers: no identity leaks, only note/timestamp', async () => {
      activeVouchesCount = 1;
      activeVouchesPage = [
        {
          voucherId: 'secret',
          note: 'quietly in your corner',
          createdAt: new Date('2026-03-03'),
          anonymous: true,
        },
      ];
      // Even if a profile row exists, an anonymous voucher's identity must not
      // be resolved or emitted.
      profiles.find.mockResolvedValue([
        { userId: 'secret', slug: 'nova', firstName: 'Nova', lastName: 'Mar' },
      ]);
      const res = await service.listVouchers(
        target(),
        'some-other-viewer',
        visibleMemberIds,
      );
      // The anonymous voucher's id is never queried for a profile: the whole
      // page is anonymous, so no profile lookup happens at all.
      expect(profiles.find).not.toHaveBeenCalled();
      expect(res.vouchers).toEqual([
        {
          slug: '',
          firstName: '',
          lastName: '',
          avatarUrl: null,
          note: 'quietly in your corner',
          createdAt: new Date('2026-03-03'),
          anonymous: true,
          relationships: null,
        },
      ]);
    });

    it('defaults to a bounded page when no pagination is supplied', async () => {
      await service.listVouchers(
        target(),
        'some-other-viewer',
        visibleMemberIds,
      );
      expect(vouchesQuery.offset).toHaveBeenCalledWith(0);
      expect(vouchesQuery.limit).toHaveBeenCalledWith(20);
    });
  });

  describe('listVouchers member-set boundary on named vouchers (ENG-436)', () => {
    it('drops a named voucher the viewer may not see and keeps the count', async () => {
      // `visibleMemberIds` is the one batched answer for status, block either
      // way, hidden-from, the 24h hide and takedown, so any of those lands
      // here as "not in the set". `namedVoucherRows` is the target's WHOLE
      // named-voucher pool (what `getNamedVoucherIds` reads), resolved up
      // front; `activeVouchesPage` is the already-filtered, already-paginated
      // page the visibility clause leaves for `getMany` to return.
      activeVouchesCount = 2;
      namedVoucherRows = [{ voucher_id: 'v1' }, { voucher_id: 'v2' }];
      visibleMemberIds.mockResolvedValue(new Set(['v2']));
      activeVouchesPage = [
        { voucherId: 'v2', note: null, createdAt: new Date('2026-01-01') },
      ];
      profiles.find.mockResolvedValue([
        { userId: 'v2', slug: 'wren', firstName: 'Wren', lastName: 'Sol' },
      ]);
      const res = await service.listVouchers(
        target(),
        'viewer-1',
        visibleMemberIds,
      );
      // One call resolves the whole roster.
      expect(visibleMemberIds).toHaveBeenCalledTimes(1);
      expect(visibleMemberIds).toHaveBeenCalledWith(['v1', 'v2']);
      // The visibility boundary is folded into the SAME query the page is
      // paginated from, so the dropped voucher never eats into a page.
      expect(vouchesQuery.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('IN (:...visibleVoucherIds)') as unknown,
        expect.objectContaining({
          viewerId: 'viewer-1',
          visibleVoucherIds: ['v2'],
        }) as unknown,
      );
      expect(res.vouchers.map((voucher) => voucher.slug)).toEqual(['wren']);
      // The dropped voucher is never resolved to a profile either.
      expect(profiles.find).toHaveBeenCalledWith({
        where: { userId: In(['v2']) },
      });
      expect(res.count).toBe(2);
    });

    it('keeps page 2 full when a hidden voucher sits earlier in the order (stable pagination)', async () => {
      // The target has 5 active named vouchers, newest first: v1 (hidden from
      // this viewer), v2..v5 (all visible). Filtering v1 out first leaves
      // [v2, v3, v4, v5]; page 2 at size 2 (offset 2) over THAT filtered order
      // is [v4, v5], a full page. The old behaviour (filter an
      // already-paginated page) would instead have paginated [v1..v5] first,
      // landed on [v3, v4] at offset 2, then dropped nothing (v1 sat on page
      // 1), so this fixture only distinguishes the two behaviours once the
      // filter and the pagination are proven to run in the right order below.
      //
      // `listVouchers` issues exactly three `vouches.createQueryBuilder`
      // calls, in this order: the count, the named-voucher-id scan
      // (`resolveVisibleNamedVoucherIds`), then the paginated page. Giving
      // each its own builder lets the assertions below pin the visibility
      // filter and the offset/limit to the SAME (page) builder, and confirm
      // the count and id-scan builders never see them.
      const countBuilder = newVouchesQueryBuilder();
      const idScanBuilder = newVouchesQueryBuilder();
      const pageBuilder = newVouchesQueryBuilder();
      const builders = [countBuilder, idScanBuilder, pageBuilder];
      let nextBuilder = 0;
      vouches.createQueryBuilder.mockImplementation(
        () => builders[nextBuilder++],
      );
      countBuilder.getCount.mockResolvedValue(5);
      idScanBuilder.getRawMany.mockResolvedValue([
        { voucher_id: 'v1' },
        { voucher_id: 'v2' },
        { voucher_id: 'v3' },
        { voucher_id: 'v4' },
        { voucher_id: 'v5' },
      ]);
      visibleMemberIds.mockResolvedValue(new Set(['v2', 'v3', 'v4', 'v5']));
      pageBuilder.getMany.mockResolvedValue([
        { voucherId: 'v4', note: null, createdAt: new Date('2026-01-02') },
        { voucherId: 'v5', note: null, createdAt: new Date('2026-01-01') },
      ]);
      profiles.find.mockResolvedValue([
        { userId: 'v4', slug: 'juno', firstName: 'Juno', lastName: 'Vale' },
        { userId: 'v5', slug: 'sol', firstName: 'Sol', lastName: 'Rae' },
      ]);
      const res = await service.listVouchers(
        target(),
        'viewer-1',
        visibleMemberIds,
        { limit: 2, offset: 2 },
      );
      // The resolver sees the whole named-voucher pool in one call.
      expect(visibleMemberIds).toHaveBeenCalledTimes(1);
      expect(visibleMemberIds).toHaveBeenCalledWith([
        'v1',
        'v2',
        'v3',
        'v4',
        'v5',
      ]);
      // The id-scan widens past the default 500-row cap by `offset + limit`,
      // so a page this deep stays exact (2 + 2 + 500 = 504).
      expect(idScanBuilder.limit).toHaveBeenCalledWith(504);
      // The visibility filter (the resolved, visible ids only) lands on the
      // PAGE builder alone, confirmed below against the other two.
      expect(pageBuilder.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('IN (:...visibleVoucherIds)') as unknown,
        expect.objectContaining({
          viewerId: 'viewer-1',
          visibleVoucherIds: ['v2', 'v3', 'v4', 'v5'],
        }) as unknown,
      );
      const countBuilderClauses = countBuilder.andWhere.mock.calls.map(
        (call: unknown[]) => call[0] as string,
      );
      const idScanBuilderClauses = idScanBuilder.andWhere.mock.calls.map(
        (call: unknown[]) => call[0] as string,
      );
      expect(
        countBuilderClauses.some((clause) =>
          clause.includes('visibleVoucherIds'),
        ),
      ).toBe(false);
      expect(
        idScanBuilderClauses.some((clause) =>
          clause.includes('visibleVoucherIds'),
        ),
      ).toBe(false);
      // The offset/limit for THIS page sit on the same page builder too.
      expect(pageBuilder.offset).toHaveBeenCalledWith(2);
      expect(pageBuilder.limit).toHaveBeenCalledWith(2);
      expect(countBuilder.offset).not.toHaveBeenCalled();
      expect(countBuilder.limit).not.toHaveBeenCalled();
      // `count` comes from the count builder alone and reports the true
      // total, hidden voucher included.
      expect(res.count).toBe(5);
      // A full page of 2 rows, exactly the requested page size.
      expect(res.vouchers.map((voucher) => voucher.slug)).toEqual([
        'juno',
        'sol',
      ]);
    });

    it('keeps anonymous rows so a vanished shielded row cannot reveal its author', async () => {
      // Split builders (see `newVouchesQueryBuilder`) so the empty-visible-set
      // SQL below can be pinned to the page query specifically.
      const countBuilder = newVouchesQueryBuilder();
      const idScanBuilder = newVouchesQueryBuilder();
      const pageBuilder = newVouchesQueryBuilder();
      const builders = [countBuilder, idScanBuilder, pageBuilder];
      let nextBuilder = 0;
      vouches.createQueryBuilder.mockImplementation(
        () => builders[nextBuilder++],
      );
      countBuilder.getCount.mockResolvedValue(1);
      idScanBuilder.getRawMany.mockResolvedValue([]); // no named vouchers at all
      pageBuilder.getMany.mockResolvedValue([
        {
          voucherId: 'secret',
          note: null,
          createdAt: new Date('2026-01-01'),
          anonymous: true,
        },
      ]);
      visibleMemberIds.mockResolvedValue(new Set());
      const res = await service.listVouchers(
        target(),
        'viewer-1',
        visibleMemberIds,
      );
      // Anonymous authors are never even asked about: the target has no
      // named voucher to resolve.
      expect(visibleMemberIds).toHaveBeenCalledWith([]);
      // With no visible ids at all, the `IN` branch is never appended: the
      // page query's visibility filter reduces to the anonymous-or-own
      // clause alone, which never emits an `IN ()`.
      expect(pageBuilder.andWhere).toHaveBeenCalledWith(
        '(v.anonymous = true OR v.voucherId = :viewerId)',
        { viewerId: 'viewer-1' },
      );
      expect(res.vouchers).toHaveLength(1);
      expect(res.vouchers[0]!.anonymous).toBe(true);
    });

    it('always shows the viewer their own vouch, even inside their own 24h hide', async () => {
      activeVouchesCount = 1;
      // The target's only named voucher is the viewer's own, so it is
      // excluded before resolution: the viewer sees their own vouch
      // unconditionally, independent of whether the resolver counts them
      // visible to themselves.
      namedVoucherRows = [{ voucher_id: 'viewer-1' }];
      visibleMemberIds.mockResolvedValue(new Set());
      activeVouchesPage = [
        {
          voucherId: 'viewer-1',
          note: null,
          createdAt: new Date('2026-01-01'),
        },
      ];
      profiles.find.mockResolvedValue([
        { userId: 'viewer-1', slug: 'me', firstName: 'Me', lastName: 'Self' },
      ]);
      const res = await service.listVouchers(
        target(),
        'viewer-1',
        visibleMemberIds,
      );
      expect(visibleMemberIds).toHaveBeenCalledWith([]);
      expect(res.vouchers.map((voucher) => voucher.slug)).toEqual(['me']);
    });

    it('applies the boundary to the owner too, so a deactivated voucher leaves their own list', async () => {
      activeVouchesCount = 1;
      namedVoucherRows = [{ voucher_id: 'v1' }];
      visibleMemberIds.mockResolvedValue(new Set());
      // Not visible to the owner either, so the SQL filter leaves the page
      // empty.
      activeVouchesPage = [];
      const res = await service.listVouchers(target(), 'u2', visibleMemberIds);
      expect(visibleMemberIds).toHaveBeenCalledWith(['v1']);
      expect(res.vouchers).toEqual([]);
      expect(res.count).toBe(1);
    });

    it('skips the lookup entirely when the roster is count-only', async () => {
      activeVouchesCount = 3;
      await service.listVouchers(
        target({ vouchersVisible: false }),
        'viewer-1',
        visibleMemberIds,
      );
      expect(visibleMemberIds).not.toHaveBeenCalled();
    });
  });

  describe('listVouchers vouchersVisible gate', () => {
    it('hides the roster (count-only) for a non-owner viewer when vouchersVisible is off', async () => {
      activeVouchesCount = 7;
      activeVouchesPage = [
        { voucherId: 'v1', note: 'ally', createdAt: new Date('2026-01-01') },
      ];
      const res = await service.listVouchers(
        target({ vouchersVisible: false }),
        'some-other-viewer',
        visibleMemberIds,
      );
      expect(res).toEqual({ count: 7, vouchers: [] });
      // The gate short-circuits before the page query even runs.
      expect(vouchesQuery.getMany).not.toHaveBeenCalled();
    });

    it('still shows the full roster to the owner even when vouchersVisible is off', async () => {
      activeVouchesCount = 1;
      namedVoucherRows = [{ voucher_id: 'v1' }];
      activeVouchesPage = [
        { voucherId: 'v1', note: 'ally', createdAt: new Date('2026-01-01') },
      ];
      profiles.find.mockResolvedValue([
        {
          userId: 'v1',
          slug: 'val',
          firstName: 'Val',
          lastName: 'Reis',
          photoVisible: true,
        },
      ]);
      const res = await service.listVouchers(
        target({ vouchersVisible: false }),
        'u2',
        visibleMemberIds,
      );
      expect(res.count).toBe(1);
      expect(res.vouchers).toHaveLength(1);
      expect(res.vouchers[0]!.slug).toBe('val');
    });

    it('shows the full roster to a non-owner viewer when vouchersVisible is on', async () => {
      activeVouchesCount = 1;
      namedVoucherRows = [{ voucher_id: 'v1' }];
      activeVouchesPage = [
        { voucherId: 'v1', note: 'ally', createdAt: new Date('2026-01-01') },
      ];
      profiles.find.mockResolvedValue([
        {
          userId: 'v1',
          slug: 'val',
          firstName: 'Val',
          lastName: 'Reis',
          photoVisible: true,
        },
      ]);
      const res = await service.listVouchers(
        target(),
        'some-other-viewer',
        visibleMemberIds,
      );
      expect(res.vouchers).toHaveLength(1);
    });
  });

  describe('listGiven', () => {
    it('returns a bounded, mapped page of vouches the user gave', async () => {
      vouches.find.mockResolvedValue([
        { voucheeId: 'w1', note: null, createdAt: new Date('2026-02-02') },
      ]);
      profiles.find.mockResolvedValue([
        { userId: 'w1', slug: 'wren', firstName: 'Wren', lastName: 'Sol' },
      ]);
      const res = await service.listGiven('u1', { limit: 5 });
      expect(vouches.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { voucherId: 'u1', withdrawnAt: IsNull() },
          take: 5,
          skip: 0,
        }),
      );
      expect(res[0]!.slug).toBe('wren');
    });
  });

  describe('getVouchDirections', () => {
    it('hides an anonymous incoming vouch so the connections badge cannot de-anonymize it', async () => {
      // `me` vouched for `a` (visible outgoing). `b` vouched for `me` but
      // anonymously — that incoming vouch must NOT surface as vouched-for-you.
      vouches.find.mockResolvedValue([
        { voucherId: 'me', voucheeId: 'a', anonymous: false },
        { voucherId: 'b', voucheeId: 'me', anonymous: true },
        { voucherId: 'c', voucheeId: 'me', anonymous: false },
      ]);
      const directions = await service.getVouchDirections('me', [
        'a',
        'b',
        'c',
      ]);
      expect([...directions.youVouched]).toEqual(['a']);
      // `b` is shielded; only the non-anonymous `c` is revealed.
      expect(directions.vouchedForYou.has('b')).toBe(false);
      expect(directions.vouchedForYou.has('c')).toBe(true);
    });
  });
});
