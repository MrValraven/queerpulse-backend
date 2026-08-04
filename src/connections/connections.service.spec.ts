import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, In, QueryFailedError } from 'typeorm';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile, ProfileVisibility } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { CONNECTION_ACCEPTED } from './connection.events';
import { Connection, ConnectionStatus } from './entities/connection.entity';
import { VouchService } from '../vouch/vouch.service';
import { ConnectionsService } from './connections.service';

const uniqueViolation = () =>
  new QueryFailedError('insert', [], {
    code: '23505',
  } as unknown as Error);

// An active, open-visibility target profile unless overridden.
const targetProfile = (overrides: Record<string, unknown> = {}) => ({
  userId: 'them',
  slug: 'them',
  visibility: ProfileVisibility.Open,
  user: { status: UserStatus.Active },
  ...overrides,
});

describe('ConnectionsService', () => {
  let service: ConnectionsService;
  let connections: {
    findOne: jest.Mock;
    findOneByOrFail: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    find: jest.Mock;
    findAndCount: jest.Mock;
    count: jest.Mock;
  };
  let profiles: { findOne: jest.Mock; find: jest.Mock };
  let vouchService: {
    getActiveVoucheeIds: jest.Mock;
    getVouchDirections: jest.Mock;
  };
  let emitter: { emit: jest.Mock };
  let blockFilter: { isBlockedEitherWay: jest.Mock };
  let manager: {
    update: jest.Mock;
    findOneByOrFail: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };

  // Chainable insert query-builder stub for the `blocks` row written inside
  // `respond('block')`'s transaction (`.insert().into().values().orIgnore()
  // .execute()`).
  const insertQbStub = (): Record<string, jest.Mock> => {
    const qb: Record<string, jest.Mock> = {};
    for (const method of ['insert', 'into', 'values', 'orIgnore']) {
      qb[method] = jest.fn().mockReturnValue(qb);
    }
    qb.execute = jest.fn().mockResolvedValue({ raw: [] });
    return qb;
  };

  beforeEach(async () => {
    connections = {
      findOne: jest.fn(),
      findOneByOrFail: jest.fn(),
      create: jest.fn((v: Record<string, unknown>) => v),
      save: jest.fn((v: Record<string, unknown>) =>
        Promise.resolve({ id: 'c1', ...v }),
      ),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      find: jest.fn().mockResolvedValue([]),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
      count: jest.fn().mockResolvedValue(0),
    };
    manager = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      findOneByOrFail: jest.fn(),
      createQueryBuilder: jest.fn(() => insertQbStub()),
    };
    dataSource = {
      transaction: jest
        .fn()
        .mockImplementation(
          (runInTransaction: (entityManager: typeof manager) => unknown) =>
            runInTransaction(manager),
        ),
    };
    profiles = { findOne: jest.fn(), find: jest.fn().mockResolvedValue([]) };
    vouchService = {
      getActiveVoucheeIds: jest.fn().mockResolvedValue([]),
      getVouchDirections: jest.fn().mockResolvedValue({
        youVouched: new Set<string>(),
        vouchedForYou: new Set<string>(),
      }),
    };
    emitter = { emit: jest.fn() };
    blockFilter = { isBlockedEitherWay: jest.fn().mockResolvedValue(false) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConnectionsService,
        { provide: getRepositoryToken(Connection), useValue: connections },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: VouchService, useValue: vouchService },
        { provide: EventEmitter2, useValue: emitter },
        { provide: BlockFilterService, useValue: blockFilter },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = module.get(ConnectionsService);
  });

  describe('requestConnection', () => {
    it('404s an unknown member', async () => {
      profiles.findOne.mockResolvedValue(null);
      await expect(
        service.requestConnection('me', 'ghost'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects connecting to yourself', async () => {
      profiles.findOne.mockResolvedValue(
        targetProfile({ userId: 'me', slug: 'me' }),
      );
      await expect(
        service.requestConnection('me', 'me'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a non-active target (§8)', async () => {
      profiles.findOne.mockResolvedValue(
        targetProfile({ user: { status: UserStatus.Suspended } }),
      );
      await expect(
        service.requestConnection('me', 'them'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects when either party has blocked the other (spec §2)', async () => {
      profiles.findOne.mockResolvedValue(targetProfile());
      blockFilter.isBlockedEitherWay.mockResolvedValueOnce(true);
      await expect(
        service.requestConnection('me', 'them'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(blockFilter.isBlockedEitherWay).toHaveBeenCalledWith('me', 'them');
      expect(connections.save).not.toHaveBeenCalled();
    });

    it('creates a pending request when no pair row exists', async () => {
      profiles.findOne.mockResolvedValue(targetProfile());
      connections.findOne.mockResolvedValue(null);
      const result = await service.requestConnection('me', 'them', 'hi there');
      expect(connections.save).toHaveBeenCalled();
      expect(result.status).toBe(ConnectionStatus.Pending);
      expect(result.requestMessage).toBe('hi there');
    });

    it('rejects a network-visibility request with no introducer (§8)', async () => {
      profiles.findOne.mockResolvedValue(
        targetProfile({ visibility: ProfileVisibility.Network }),
      );
      connections.findOne.mockResolvedValue(null); // no existing pair
      await expect(
        service.requestConnection('me', 'them'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows a network request with an introducer connected to both (§8)', async () => {
      profiles.findOne
        .mockResolvedValueOnce(
          targetProfile({ visibility: ProfileVisibility.Network }),
        )
        .mockResolvedValueOnce({ userId: 'intro', slug: 'intro' }); // introducer
      connections.findOne
        .mockResolvedValueOnce(null) // existing pair lookup
        .mockResolvedValueOnce({ status: ConnectionStatus.Accepted }) // me<->intro
        .mockResolvedValueOnce({ status: ConnectionStatus.Accepted }); // them<->intro
      const result = await service.requestConnection(
        'me',
        'them',
        undefined,
        'intro',
      );
      expect(result.status).toBe(ConnectionStatus.Pending);
      expect(result.introducedBy).toBe('intro');
      expect(result.flagged).toBe(false);
    });

    it('rejects a network introducer connected to only one side (§8)', async () => {
      profiles.findOne
        .mockResolvedValueOnce(
          targetProfile({ visibility: ProfileVisibility.Network }),
        )
        .mockResolvedValueOnce({ userId: 'intro', slug: 'intro' });
      connections.findOne
        .mockResolvedValueOnce(null) // existing pair
        .mockResolvedValueOnce({ status: ConnectionStatus.Accepted }) // me<->intro
        .mockResolvedValueOnce(null); // them<->intro NOT connected
      await expect(
        service.requestConnection('me', 'them', undefined, 'intro'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404s an unknown introducer (§8)', async () => {
      profiles.findOne
        .mockResolvedValueOnce(
          targetProfile({ visibility: ProfileVisibility.Network }),
        )
        .mockResolvedValueOnce(null); // introducer not found
      connections.findOne.mockResolvedValueOnce(null); // existing pair
      await expect(
        service.requestConnection('me', 'them', undefined, 'ghost'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('allows and flags a private-visibility request (§8)', async () => {
      profiles.findOne.mockResolvedValue(
        targetProfile({ visibility: ProfileVisibility.Private }),
      );
      connections.findOne.mockResolvedValue(null);
      const result = await service.requestConnection('me', 'them');
      expect(result.status).toBe(ConnectionStatus.Pending);
      expect(result.flagged).toBe(true);
      expect(result.introducedBy).toBeNull();
    });

    it('emits CONNECTION_REQUESTED with introducedBy for an introduced request', async () => {
      profiles.findOne
        .mockResolvedValueOnce(
          targetProfile({ visibility: ProfileVisibility.Network }),
        )
        .mockResolvedValueOnce({ userId: 'intro', slug: 'intro' });
      connections.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ status: ConnectionStatus.Accepted })
        .mockResolvedValueOnce({ status: ConnectionStatus.Accepted });
      await service.requestConnection('me', 'them', undefined, 'intro');
      expect(emitter.emit).toHaveBeenCalledWith(
        'connection.requested',
        expect.objectContaining({ introducedBy: 'intro' }),
      );
    });

    it('rejects when already connected', async () => {
      profiles.findOne.mockResolvedValue(targetProfile());
      connections.findOne.mockResolvedValue({
        id: 'c1',
        status: ConnectionStatus.Accepted,
      });
      await expect(
        service.requestConnection('me', 'them'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('reopens a previously declined relationship as a fresh request', async () => {
      profiles.findOne.mockResolvedValue(targetProfile());
      connections.findOne.mockResolvedValue({
        id: 'c1',
        status: ConnectionStatus.Declined,
        blockedBy: null,
      });
      const result = await service.requestConnection('me', 'them', 'again?');
      expect(result.status).toBe(ConnectionStatus.Pending);
      expect(result.requestMessage).toBe('again?');
      expect(result.respondedAt).toBeNull();
    });

    it('does not disclose that the other member blocked you (indistinguishable 409)', async () => {
      profiles.findOne.mockResolvedValue(targetProfile());
      connections.findOne.mockResolvedValue({
        id: 'c1',
        status: ConnectionStatus.Blocked,
        blockedBy: 'them',
      });
      await expect(
        service.requestConnection('me', 'them'),
      ).rejects.toMatchObject({
        response: { message: 'A request is already pending' },
      });
    });

    it('tells you to unblock when YOU placed the block', async () => {
      profiles.findOne.mockResolvedValue(targetProfile());
      connections.findOne.mockResolvedValue({
        id: 'c1',
        status: ConnectionStatus.Blocked,
        blockedBy: 'me',
      });
      await expect(
        service.requestConnection('me', 'them'),
      ).rejects.toMatchObject({
        response: { message: 'Unblock this member before sending a request' },
      });
    });

    it('maps a 23505 on the pair to a 409', async () => {
      profiles.findOne.mockResolvedValue(targetProfile());
      connections.findOne.mockResolvedValue(null);
      connections.save.mockRejectedValue(uniqueViolation());
      await expect(
        service.requestConnection('me', 'them'),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('requestConnectionView', () => {
    // The profile the mapper resolves for the addressee (`them`).
    const otherMemberProfile = {
      userId: 'them',
      slug: 'them',
      firstName: 'Thea',
      lastName: 'Oxton',
      avatarUrl: null,
      pronouns: 'they/them',
      tagline: 'here to help',
    };

    it('returns the same ConnectionListItem shape the list path uses', async () => {
      profiles.findOne.mockResolvedValue(targetProfile());
      connections.findOne.mockResolvedValue(null);
      profiles.find.mockResolvedValue([otherMemberProfile]);

      const result = await service.requestConnectionView('me', 'them', 'hi');

      expect(result).toEqual({
        id: 'c1',
        status: ConnectionStatus.Pending,
        direction: 'outgoing',
        requestMessage: 'hi',
        requestReason: null,
        createdAt: undefined,
        respondedAt: undefined,
        member: {
          slug: 'them',
          firstName: 'Thea',
          lastName: 'Oxton',
          avatarUrl: null,
          pronouns: 'they/them',
          tagline: 'here to help',
        },
        mutuals: 0,
        vouchBadge: null,
        introducedBy: null,
      });
    });

    it('never leaks raw entity columns', async () => {
      profiles.findOne.mockResolvedValue(targetProfile());
      connections.findOne.mockResolvedValue(null);
      profiles.find.mockResolvedValue([otherMemberProfile]);

      const result = await service.requestConnectionView('me', 'them', 'hi');

      for (const leaked of [
        'userLow',
        'userHigh',
        'blockedBy',
        'flagged',
        'requesterId',
        'addresseeId',
      ]) {
        expect(result).not.toHaveProperty(leaked);
      }
    });

    it('resolves the introducer profile for an introduced request', async () => {
      // Network target + an introducer connected to both sides passes the gate.
      profiles.findOne
        .mockResolvedValueOnce(
          targetProfile({ visibility: ProfileVisibility.Network }),
        )
        .mockResolvedValueOnce({ userId: 'intro', slug: 'intro' }); // introducer
      connections.findOne
        .mockResolvedValueOnce(null) // existing pair lookup
        .mockResolvedValueOnce({ status: ConnectionStatus.Accepted }) // me<->intro
        .mockResolvedValueOnce({ status: ConnectionStatus.Accepted }); // them<->intro
      profiles.find.mockResolvedValue([
        otherMemberProfile,
        {
          userId: 'intro',
          slug: 'intro',
          firstName: 'Ira',
          lastName: 'Voss',
          avatarUrl: null,
          pronouns: null,
          tagline: null,
        },
      ]);

      const result = await service.requestConnectionView(
        'me',
        'them',
        undefined,
        'intro',
      );

      expect(result.member.slug).toBe('them');
      expect(result.introducedBy?.slug).toBe('intro');
    });
  });

  describe('respond', () => {
    it('404s an unknown connection', async () => {
      connections.findOne.mockResolvedValue(null);
      await expect(
        service.respond('c1', 'me', 'accept'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects an actor who is not part of the connection', async () => {
      connections.findOne.mockResolvedValue({
        id: 'c1',
        requesterId: 'a',
        addresseeId: 'b',
        status: ConnectionStatus.Pending,
      });
      await expect(
        service.respond('c1', 'stranger', 'accept'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('only the addressee can accept a pending request', async () => {
      connections.findOne.mockResolvedValue({
        id: 'c1',
        requesterId: 'me',
        addresseeId: 'them',
        status: ConnectionStatus.Pending,
      });
      await expect(
        service.respond('c1', 'me', 'accept'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('accepts via a conditional claim and emits CONNECTION_ACCEPTED once', async () => {
      connections.findOne.mockResolvedValue({
        id: 'c1',
        requesterId: 'them',
        addresseeId: 'me',
        status: ConnectionStatus.Pending,
        requestMessage: 'hi',
      });
      const result = await service.respond('c1', 'me', 'accept');
      expect(connections.update).toHaveBeenCalledWith(
        { id: 'c1', status: ConnectionStatus.Pending },
        {
          status: ConnectionStatus.Accepted,
          respondedAt: expect.any(Date) as unknown,
        },
      );
      expect(result.status).toBe(ConnectionStatus.Accepted);
      expect(emitter.emit).toHaveBeenCalledWith(
        CONNECTION_ACCEPTED,
        expect.objectContaining({ connectionId: 'c1', requestMessage: 'hi' }),
      );
    });

    it('loses the race (affected 0) → 409 and no event', async () => {
      connections.findOne.mockResolvedValue({
        id: 'c1',
        requesterId: 'them',
        addresseeId: 'me',
        status: ConnectionStatus.Pending,
      });
      connections.update.mockResolvedValue({ affected: 0 });
      await expect(
        service.respond('c1', 'me', 'accept'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('cannot seize a block the OTHER party placed (atomic, no-op update)', async () => {
      connections.findOne.mockResolvedValue({
        id: 'c1',
        requesterId: 'me',
        addresseeId: 'them',
        status: ConnectionStatus.Blocked,
        blockedBy: 'them',
      });
      // The conditional UPDATE matches nothing (row already Blocked), so the
      // in-transaction re-read finds the other party still owns the block.
      manager.update.mockResolvedValue({ affected: 0 });
      manager.findOneByOrFail.mockResolvedValue({
        id: 'c1',
        status: ConnectionStatus.Blocked,
        blockedBy: 'them',
      });
      await expect(service.respond('c1', 'me', 'block')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('places a block on a pending connection and records a blocks row', async () => {
      connections.findOne.mockResolvedValue({
        id: 'c1',
        requesterId: 'me',
        addresseeId: 'them',
        status: ConnectionStatus.Pending,
        blockedBy: null,
      });
      manager.update.mockResolvedValue({ affected: 1 });
      connections.findOneByOrFail.mockResolvedValue({
        id: 'c1',
        status: ConnectionStatus.Blocked,
        blockedBy: 'me',
      });
      const result = await service.respond('c1', 'me', 'block');
      expect(result.status).toBe(ConnectionStatus.Blocked);
      expect(result.blockedBy).toBe('me');
      // A first-class `blocks` row is written so BlockFilterService sees it.
      expect(manager.createQueryBuilder).toHaveBeenCalled();
    });

    it('only the blocker can unblock', async () => {
      connections.findOne.mockResolvedValue({
        id: 'c1',
        requesterId: 'me',
        addresseeId: 'them',
        status: ConnectionStatus.Blocked,
        blockedBy: 'them',
      });
      await expect(
        service.respond('c1', 'me', 'unblock'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('remove', () => {
    it('rejects deleting a block the OTHER party placed', async () => {
      connections.findOne.mockResolvedValue({
        id: 'c1',
        requesterId: 'me',
        addresseeId: 'them',
        status: ConnectionStatus.Blocked,
        blockedBy: 'them',
      });
      await expect(service.remove('c1', 'me')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(connections.delete).not.toHaveBeenCalled();
    });

    it('removes an accepted connection the actor is part of', async () => {
      connections.findOne.mockResolvedValue({
        id: 'c1',
        requesterId: 'me',
        addresseeId: 'them',
        status: ConnectionStatus.Accepted,
        blockedBy: null,
      });
      await expect(service.remove('c1', 'me')).resolves.toEqual({ ok: true });
      expect(connections.delete).toHaveBeenCalledWith('c1');
    });
  });

  describe('list', () => {
    it('incoming: pending where the user is addressee, paginated by page', async () => {
      connections.findAndCount.mockResolvedValue([[], 0]);
      // page 3 → skip (3-1)*20 = 40, take 20.
      const res = await service.list('me', 'incoming', { page: 3 });
      expect(connections.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { addresseeId: 'me', status: ConnectionStatus.Pending },
          take: 20,
          skip: 40,
        }),
      );
      expect(res).toEqual({ items: [], total: 0, page: 3, pageSize: 20 });
    });

    it('outgoing: pending where the user is requester, defaulted page', async () => {
      await service.list('me', 'outgoing');
      expect(connections.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { requesterId: 'me', status: ConnectionStatus.Pending },
          take: 20,
          skip: 0,
        }),
      );
    });

    it('all: accepted connections, defaulted page', async () => {
      await service.list('me', 'all');
      expect(connections.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ take: 20, skip: 0 }),
      );
    });

    it('all: returns the paginated envelope with the server total', async () => {
      connections.findAndCount.mockResolvedValue([
        [{ id: 'x', requesterId: 'me', addresseeId: 'a', status: 'accepted' }],
        7,
      ]);
      const res = await service.list('me', 'all', { page: 1 });
      expect(res.total).toBe(7);
      expect(res.page).toBe(1);
      expect(res.pageSize).toBe(20);
      expect(res.items).toHaveLength(1);
    });

    it('vouched: filters accepted connections to members the user vouched for, with an honest total', async () => {
      // VouchService owns "who did I vouch for"; the intersection with accepted
      // connections is pushed into `findAndCount` (bounded + server-side total).
      vouchService.getActiveVoucheeIds.mockResolvedValue(['a']);
      connections.findAndCount.mockResolvedValue([
        [{ id: 'x', requesterId: 'me', addresseeId: 'a', status: 'accepted' }],
        1,
      ]);
      const res = await service.list('me', 'vouched');
      expect(vouchService.getActiveVoucheeIds).toHaveBeenCalledWith('me');
      expect(connections.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: [
            {
              requesterId: 'me',
              addresseeId: In(['a']),
              status: ConnectionStatus.Accepted,
            },
            {
              addresseeId: 'me',
              requesterId: In(['a']),
              status: ConnectionStatus.Accepted,
            },
          ],
          take: 20,
          skip: 0,
        }),
      );
      expect(res.total).toBe(1);
      expect(res.items).toHaveLength(1);
      expect(res.items[0]?.id).toBe('x');
    });

    it('vouched: short-circuits to an empty page when the viewer has vouched for nobody', async () => {
      vouchService.getActiveVoucheeIds.mockResolvedValue([]);
      const res = await service.list('me', 'vouched');
      expect(connections.findAndCount).not.toHaveBeenCalled();
      expect(res).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
    });

    it('includes the introducer member view on incoming requests', async () => {
      connections.findAndCount.mockResolvedValue([
        [
          {
            id: 'c1',
            status: ConnectionStatus.Pending,
            requesterId: 'them',
            addresseeId: 'me',
            introducedBy: 'intro',
            createdAt: new Date(),
            respondedAt: null,
            requestMessage: null,
          },
        ],
        1,
      ]);
      profiles.find.mockResolvedValue([
        { userId: 'them', slug: 'them', firstName: 'T', lastName: 'Hem' },
        { userId: 'intro', slug: 'intro', firstName: 'In', lastName: 'Tro' },
      ]);
      const { items } = await service.list('me', 'incoming');
      const [item] = items;
      expect(item?.introducedBy).not.toBeNull();
      expect(item?.introducedBy?.slug).toBe('intro');
    });

    it('counts accepted connections shared with the viewer as mutuals', async () => {
      connections.findAndCount.mockResolvedValue([
        [
          {
            id: 'c1',
            status: ConnectionStatus.Accepted,
            requesterId: 'me',
            addresseeId: 'a',
            introducedBy: null,
            createdAt: new Date(),
            respondedAt: new Date(),
            requestMessage: null,
            requestReason: null,
          },
        ],
        1,
      ]);
      // First find: every accepted edge touching the page's members — `a` is
      // connected to `x`, so `x` is the candidate mutual to test.
      // Second find: of that candidate, `x` is also one of the viewer's accepted
      // connections — the one shared mutual.
      connections.find
        .mockResolvedValueOnce([
          { requesterId: 'a', addresseeId: 'x', status: 'accepted' },
        ])
        .mockResolvedValueOnce([
          { requesterId: 'me', addresseeId: 'x', status: 'accepted' },
        ]);
      profiles.find.mockResolvedValue([
        { userId: 'a', slug: 'a', firstName: 'A', lastName: 'Ok' },
      ]);

      const { items } = await service.list('me', 'all');
      expect(items[0]?.mutuals).toBe(1);
    });

    it('derives a mutual vouch badge from vouches in both directions', async () => {
      connections.findAndCount.mockResolvedValue([
        [
          {
            id: 'c1',
            status: ConnectionStatus.Accepted,
            requesterId: 'me',
            addresseeId: 'a',
            introducedBy: null,
            createdAt: new Date(),
            respondedAt: new Date(),
            requestMessage: null,
            requestReason: null,
          },
        ],
        1,
      ]);
      // Vouches in both directions between the viewer and `a` → a mutual badge.
      vouchService.getVouchDirections.mockResolvedValue({
        youVouched: new Set<string>(['a']),
        vouchedForYou: new Set<string>(['a']),
      });
      profiles.find.mockResolvedValue([
        { userId: 'a', slug: 'a', firstName: 'A', lastName: 'Ok' },
      ]);

      const { items } = await service.list('me', 'all');
      expect(items[0]?.vouchBadge).toBe('mutual');
    });
  });

  describe('getAcceptedConnectionSlugs', () => {
    it('returns slugs of both counterparts of accepted edges and excludes pending/declined', async () => {
      // viewer 'u-viewer' has an accepted edge with 'u-alina' (slug 'alina') and a
      // pending edge with 'u-mara'. Mock the connections repo find to return only the
      // accepted rows (mirrors getAcceptedConnectionUserIds' where-clause) and
      // profilesByUserIds to resolve 'u-alina' -> { slug: 'alina' }.
      connections.find.mockResolvedValue([
        {
          requesterId: 'u-viewer',
          addresseeId: 'u-alina',
          status: ConnectionStatus.Accepted,
        },
      ]);
      profiles.find.mockResolvedValue([{ userId: 'u-alina', slug: 'alina' }]);

      const slugs = await service.getAcceptedConnectionSlugs('u-viewer');

      expect(slugs).toEqual(['alina']);
    });

    it('returns an empty array with no accepted connections, skipping the profile lookup', async () => {
      connections.find.mockResolvedValue([]);

      const slugs = await service.getAcceptedConnectionSlugs('u-viewer');

      expect(slugs).toEqual([]);
      expect(profiles.find).not.toHaveBeenCalled();
    });
  });

  describe('areConnected', () => {
    it('is true only for an accepted pair', async () => {
      connections.findOne.mockResolvedValue({
        status: ConnectionStatus.Accepted,
      });
      await expect(service.areConnected('a', 'b')).resolves.toBe(true);
      connections.findOne.mockResolvedValue({
        status: ConnectionStatus.Pending,
      });
      await expect(service.areConnected('a', 'b')).resolves.toBe(false);
    });
  });
});
