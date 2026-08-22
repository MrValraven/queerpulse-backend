import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, IsNull, QueryFailedError } from 'typeorm';
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

describe('VouchService', () => {
  let service: VouchService;
  let vouches: {
    findOne: jest.Mock;
    find: jest.Mock;
    count: jest.Mock;
    update: jest.Mock;
  };
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
    vouches = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    profiles = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      // `createVouch` resolves the vouchee through an ACTIVE-user join, so it
      // goes via a query builder while `withdrawVouch`/`listVouchers` still use
      // `findOne`. Delegating `getOne()` to the same `findOne` mock keeps every
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

  describe('listVouchers excludes withdrawn', () => {
    it('filters count and rows by withdrawnAt IS NULL', async () => {
      profiles.findOne.mockResolvedValue({
        userId: 'u2',
        slug: 'target',
        vouchersVisible: true,
      });
      vouches.count.mockResolvedValue(0);
      vouches.find.mockResolvedValue([]);
      await service.listVouchers('target');
      expect(vouches.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            withdrawnAt: expect.anything() as unknown,
          }) as unknown,
        }),
      );
      expect(vouches.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            withdrawnAt: expect.anything() as unknown,
          }) as unknown,
        }),
      );
    });
  });

  describe('listVouchers', () => {
    it('404s an unknown member', async () => {
      profiles.findOne.mockResolvedValue(null);
      await expect(service.listVouchers('ghost')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('returns the full count and a bounded, mapped page', async () => {
      profiles.findOne.mockResolvedValue({
        userId: 'u2',
        slug: 'them',
        vouchersVisible: true,
      });
      vouches.count.mockResolvedValue(42);
      vouches.find.mockResolvedValue([
        { voucherId: 'v1', note: 'ally', createdAt: new Date('2026-01-01') },
      ]);
      profiles.find.mockResolvedValue([
        { userId: 'v1', slug: 'val', firstName: 'Val', lastName: 'Reis' },
      ]);
      const res = await service.listVouchers('them', { limit: 10, offset: 5 });
      expect(vouches.find).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10, skip: 5 }),
      );
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

    it('shields anonymous vouchers — no identity leaks, only note/timestamp', async () => {
      profiles.findOne.mockResolvedValue({
        userId: 'u2',
        slug: 'them',
        vouchersVisible: true,
      });
      vouches.count.mockResolvedValue(1);
      vouches.find.mockResolvedValue([
        {
          voucherId: 'secret',
          note: 'quietly in your corner',
          createdAt: new Date('2026-03-03'),
          anonymous: true,
        },
      ]);
      // Even if a profile row exists, an anonymous voucher's identity must not
      // be resolved or emitted.
      profiles.find.mockResolvedValue([
        { userId: 'secret', slug: 'nova', firstName: 'Nova', lastName: 'Mar' },
      ]);
      const res = await service.listVouchers('them');
      // The anonymous voucher's id is never queried for a profile — the whole
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
      profiles.findOne.mockResolvedValue({
        userId: 'u2',
        slug: 'them',
        vouchersVisible: true,
      });
      await service.listVouchers('them');
      expect(vouches.find).toHaveBeenCalledWith(
        expect.objectContaining({ take: 20, skip: 0 }),
      );
    });
  });

  describe('listVouchers vouchersVisible gate', () => {
    it('hides the roster (count-only) for a non-owner viewer when vouchersVisible is off', async () => {
      profiles.findOne.mockResolvedValue({
        userId: 'u2',
        slug: 'them',
        vouchersVisible: false,
      });
      vouches.count.mockResolvedValue(7);
      vouches.find.mockResolvedValue([
        { voucherId: 'v1', note: 'ally', createdAt: new Date('2026-01-01') },
      ]);
      const res = await service.listVouchers(
        'them',
        undefined,
        'some-other-viewer',
      );
      expect(res).toEqual({ count: 7, vouchers: [] });
      // The gate short-circuits before the page query even runs.
      expect(vouches.find).not.toHaveBeenCalled();
    });

    it('hides the roster for an unauthenticated/unknown viewer the same way', async () => {
      profiles.findOne.mockResolvedValue({
        userId: 'u2',
        slug: 'them',
        vouchersVisible: false,
      });
      vouches.count.mockResolvedValue(3);
      const res = await service.listVouchers('them');
      expect(res).toEqual({ count: 3, vouchers: [] });
    });

    it('still shows the full roster to the owner even when vouchersVisible is off', async () => {
      profiles.findOne.mockResolvedValue({
        userId: 'u2',
        slug: 'them',
        vouchersVisible: false,
      });
      vouches.count.mockResolvedValue(1);
      vouches.find.mockResolvedValue([
        { voucherId: 'v1', note: 'ally', createdAt: new Date('2026-01-01') },
      ]);
      profiles.find.mockResolvedValue([
        { userId: 'v1', slug: 'val', firstName: 'Val', lastName: 'Reis' },
      ]);
      const res = await service.listVouchers('them', undefined, 'u2');
      expect(res.count).toBe(1);
      expect(res.vouchers).toHaveLength(1);
      expect(res.vouchers[0]!.slug).toBe('val');
    });

    it('shows the full roster to a non-owner viewer when vouchersVisible is on', async () => {
      profiles.findOne.mockResolvedValue({
        userId: 'u2',
        slug: 'them',
        vouchersVisible: true,
      });
      vouches.count.mockResolvedValue(1);
      vouches.find.mockResolvedValue([
        { voucherId: 'v1', note: 'ally', createdAt: new Date('2026-01-01') },
      ]);
      profiles.find.mockResolvedValue([
        { userId: 'v1', slug: 'val', firstName: 'Val', lastName: 'Reis' },
      ]);
      const res = await service.listVouchers(
        'them',
        undefined,
        'some-other-viewer',
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
