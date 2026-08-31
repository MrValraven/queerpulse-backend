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
import { ConnectionDecline } from './entities/connection-decline.entity';
import { ConnectionNote } from './entities/connection-note.entity';
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
    createQueryBuilder: jest.Mock;
  };
  let connectionNotes: {
    find: jest.Mock;
    delete: jest.Mock;
    upsert: jest.Mock;
  };
  let connectionDeclines: { findOne: jest.Mock };
  let profiles: { findOne: jest.Mock; find: jest.Mock };
  let vouchService: {
    getActiveVoucheeIds: jest.Mock;
    getVouchDirections: jest.Mock;
  };
  let emitter: { emit: jest.Mock };
  let blockFilter: { isBlockedEitherWay: jest.Mock };
  let manager: {
    update: jest.Mock;
    delete: jest.Mock;
    query: jest.Mock;
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

  // Chainable SELECT query-builder stub for the searched/sorted list path
  // (`.setParameter().innerJoin().where().andWhere().orderBy()...`). `clone()`
  // returns the same object, so a test can assert on every call the service
  // made regardless of which clone made it.
  const selectQbStub = (
    rows: unknown[] = [],
    total = 0,
  ): Record<string, jest.Mock> => {
    const qb: Record<string, jest.Mock> = {};
    for (const method of [
      'setParameter',
      'innerJoin',
      'where',
      'andWhere',
      'orderBy',
      'addOrderBy',
      'offset',
      'limit',
      'clone',
    ]) {
      qb[method] = jest.fn().mockReturnValue(qb);
    }
    qb.getManyAndCount = jest.fn().mockResolvedValue([rows, total]);
    qb.getMany = jest.fn().mockResolvedValue(rows);
    qb.getCount = jest.fn().mockResolvedValue(total);
    return qb;
  };

  /** Every SQL fragment the service handed to `andWhere`, joined for matching. */
  const whereFragments = (qb: Record<string, jest.Mock>): string =>
    [...qb.where!.mock.calls, ...qb.andWhere!.mock.calls]
      .map((call) => String(call[0]))
      .join(' | ');

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
      createQueryBuilder: jest.fn(() => selectQbStub()),
    };
    manager = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
      query: jest.fn().mockResolvedValue([]),
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
    connectionNotes = {
      find: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
      upsert: jest.fn().mockResolvedValue({ identifiers: [] }),
    };
    connectionDeclines = { findOne: jest.fn().mockResolvedValue(null) };
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
        {
          provide: getRepositoryToken(ConnectionNote),
          useValue: connectionNotes,
        },
        {
          provide: getRepositoryToken(ConnectionDecline),
          useValue: connectionDeclines,
        },
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

    it('reopens a declined pair with no decline record on file', async () => {
      // Rows declined before PRD-20 shipped and never backfilled: nothing is
      // on hold, so the pair re-opens exactly as it always did.
      profiles.findOne.mockResolvedValue(targetProfile());
      connections.findOne.mockResolvedValue({
        id: 'c1',
        status: ConnectionStatus.Declined,
        blockedBy: null,
      });
      connectionDeclines.findOne.mockResolvedValue(null);
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

  // PRD-20. Declining a request used to stop nothing: the pair re-opened
  // immediately as a fresh pending request carrying a brand-new free-text
  // message, so the request note was a text channel that survived refusal.
  describe('re-request after a decline (PRD-20)', () => {
    const daysAgo = (days: number): Date =>
      new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    /** A pair row sitting at `declined`, as `respond('decline')` leaves it. */
    const declinedPair = () => ({
      id: 'c1',
      requesterId: 'me',
      addresseeId: 'them',
      status: ConnectionStatus.Declined,
      blockedBy: null,
    });

    const declineRecord = (declineCount: number, lastDeclinedAt: Date) => ({
      id: 'd1',
      requesterId: 'me',
      addresseeId: 'them',
      declineCount,
      lastDeclinedAt,
    });

    it('refuses a re-request inside the first cooldown', async () => {
      profiles.findOne.mockResolvedValue(targetProfile());
      connections.findOne.mockResolvedValue(declinedPair());
      connectionDeclines.findOne.mockResolvedValue(
        declineRecord(1, daysAgo(3)),
      );

      await expect(
        service.requestConnection('me', 'them', 'please reconsider'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(connections.save).not.toHaveBeenCalled();
    });

    it('phrases the refusal exactly like a block, revealing nothing new', async () => {
      profiles.findOne.mockResolvedValue(targetProfile());
      connections.findOne.mockResolvedValue(declinedPair());
      connectionDeclines.findOne.mockResolvedValue(
        declineRecord(2, daysAgo(1)),
      );

      // The same string `requestConnection` returns when the OTHER member has
      // blocked you, so a cooldown, a cap and a block are one answer.
      await expect(
        service.requestConnection('me', 'them'),
      ).rejects.toMatchObject({
        response: { message: 'A request is already pending' },
      });
    });

    it('allows a re-request once the first cooldown has run out', async () => {
      profiles.findOne.mockResolvedValue(targetProfile());
      connections.findOne.mockResolvedValue(declinedPair());
      connectionDeclines.findOne.mockResolvedValue(
        declineRecord(1, daysAgo(20)),
      );

      const result = await service.requestConnection('me', 'them');
      expect(result.status).toBe(ConnectionStatus.Pending);
      expect(result.respondedAt).toBeNull();
    });

    it('drops the requester free text on a re-request after a decline', async () => {
      profiles.findOne.mockResolvedValue(targetProfile());
      connections.findOne.mockResolvedValue(declinedPair());
      connectionDeclines.findOne.mockResolvedValue(
        declineRecord(1, daysAgo(20)),
      );

      const result = await service.requestConnection(
        'me',
        'them',
        'you never replied, here is why you should',
        undefined,
        'custom:we met at the fair',
      );
      expect(result.status).toBe(ConnectionStatus.Pending);
      expect(result.requestMessage).toBeNull();
      expect(result.requestReason).toBeNull();
    });

    it('escalates: a second decline costs far more than the first', async () => {
      profiles.findOne.mockResolvedValue(targetProfile());
      connections.findOne.mockResolvedValue(declinedPair());
      // 20 days clears a FIRST decline (14 days) but not a second (90 days).
      connectionDeclines.findOne.mockResolvedValue(
        declineRecord(2, daysAgo(20)),
      );

      await expect(
        service.requestConnection('me', 'them'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(connections.save).not.toHaveBeenCalled();
    });

    it('allows a re-request once the second, longer cooldown has run out', async () => {
      profiles.findOne.mockResolvedValue(targetProfile());
      connections.findOne.mockResolvedValue(declinedPair());
      connectionDeclines.findOne.mockResolvedValue(
        declineRecord(2, daysAgo(100)),
      );

      const result = await service.requestConnection('me', 'them');
      expect(result.status).toBe(ConnectionStatus.Pending);
    });

    it('caps at three declines: no waiting period reopens it', async () => {
      profiles.findOne.mockResolvedValue(targetProfile());
      connections.findOne.mockResolvedValue(declinedPair());
      connectionDeclines.findOne.mockResolvedValue(
        declineRecord(3, daysAgo(400)),
      );

      await expect(
        service.requestConnection('me', 'them'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(connections.save).not.toHaveBeenCalled();
    });

    it('gates the fresh-create path too, so deleting the row does not clear the hold', async () => {
      // `remove` DELETEs a declined pair row and either party may call it, so
      // "decline, delete, ask again" must meet the same hold as a re-open.
      profiles.findOne.mockResolvedValue(targetProfile());
      connections.findOne.mockResolvedValue(null); // row is gone
      connectionDeclines.findOne.mockResolvedValue(
        declineRecord(1, daysAgo(2)),
      );

      await expect(
        service.requestConnection('me', 'them', 'hi again'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(connections.save).not.toHaveBeenCalled();
    });

    it('never gates the OTHER direction: the decliner can still reach out', async () => {
      // `them` declined `me`. That must cost `them` nothing when they decide to
      // request `me` themselves.
      profiles.findOne.mockResolvedValue(
        targetProfile({ userId: 'me', slug: 'me' }),
      );
      connections.findOne.mockResolvedValue(declinedPair());
      connectionDeclines.findOne.mockImplementation(
        (options: { where: { requesterId: string; addresseeId: string } }) =>
          Promise.resolve(
            options.where.requesterId === 'me' &&
              options.where.addresseeId === 'them'
              ? declineRecord(3, daysAgo(1))
              : null,
          ),
      );

      const result = await service.requestConnection(
        'them',
        'me',
        'actually, let us talk',
      );
      expect(result.status).toBe(ConnectionStatus.Pending);
      expect(result.requesterId).toBe('them');
      expect(result.addresseeId).toBe('me');
      // The other direction carries no decline history, so the words survive.
      expect(result.requestMessage).toBe('actually, let us talk');
      expect(connectionDeclines.findOne).toHaveBeenCalledWith({
        where: { requesterId: 'them', addresseeId: 'me' },
      });
    });
  });

  describe('decline ledger (PRD-20)', () => {
    it('records the decline in the same transaction as the status flip', async () => {
      connections.findOne.mockResolvedValue({
        id: 'c1',
        requesterId: 'them',
        addresseeId: 'me',
        status: ConnectionStatus.Pending,
      });

      const result = await service.respond('c1', 'me', 'decline');

      expect(result.status).toBe(ConnectionStatus.Declined);
      expect(dataSource.transaction).toHaveBeenCalled();
      const [sql, parameters] = manager.query.mock.calls[0] as [
        string,
        unknown[],
      ];
      expect(sql).toContain('INSERT INTO "connection_declines"');
      // Upsert that increments in one statement, so two concurrent declines
      // cannot both read the same count and write the same value.
      expect(sql).toContain('"decline_count" + 1');
      expect(parameters.slice(0, 2)).toEqual(['them', 'me']);
      // A decline still emits nothing: the requester learns of it only by the
      // request quietly leaving their outgoing tab.
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('does not record a decline when the claim loses the race', async () => {
      connections.findOne.mockResolvedValue({
        id: 'c1',
        requesterId: 'them',
        addresseeId: 'me',
        status: ConnectionStatus.Pending,
      });
      manager.update.mockResolvedValue({ affected: 0 });

      await expect(
        service.respond('c1', 'me', 'decline'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(manager.query).not.toHaveBeenCalled();
    });

    it('clears the ledger in both directions when the request is accepted', async () => {
      connections.findOne.mockResolvedValue({
        id: 'c1',
        requesterId: 'them',
        addresseeId: 'me',
        status: ConnectionStatus.Pending,
      });

      await service.respond('c1', 'me', 'accept');

      expect(manager.query).not.toHaveBeenCalled();
      expect(manager.delete).toHaveBeenCalledWith(ConnectionDecline, [
        { requesterId: 'them', addresseeId: 'me' },
        { requesterId: 'me', addresseeId: 'them' },
      ]);
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
        // The viewer sent this request, so the card can attribute its words.
        isRequestedByYou: true,
        // A brand-new request has no private note by definition.
        note: null,
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
      // The claim moved inside a transaction alongside the decline-ledger
      // write (PRD-20), so it goes through the entity manager now.
      expect(manager.update).toHaveBeenCalledWith(
        Connection,
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
      manager.update.mockResolvedValue({ affected: 0 });
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

  describe('list: search and sort (SOC-14)', () => {
    const acceptedRow = (id: string, otherUserId: string) => ({
      id,
      status: ConnectionStatus.Accepted,
      requesterId: 'me',
      addresseeId: otherUserId,
      introducedBy: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      respondedAt: new Date('2026-01-02T00:00:00.000Z'),
      requestMessage: null,
      requestReason: null,
    });

    it('leaves the plain list untouched: no term and the default sort still use findAndCount', async () => {
      await service.list('me', 'all', { page: 1 });
      expect(connections.findAndCount).toHaveBeenCalled();
      expect(connections.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('q: joins the other profile and matches name, handle, and headline through one folded LIKE', async () => {
      const qb = selectQbStub([], 0);
      connections.createQueryBuilder.mockReturnValue(qb);

      await service.list('me', 'all', { q: 'Sao' });

      expect(connections.createQueryBuilder).toHaveBeenCalledWith('connection');
      expect(qb.innerJoin).toHaveBeenCalled();
      const fragments = whereFragments(qb);
      // Both sides of the comparison go through the same fold, which is what
      // makes "Sao" find "Sao Paulo" and "Sao Paulo" alike.
      expect(fragments).toContain('translate(lower(');
      expect(fragments).toContain('other.first_name');
      expect(fragments).toContain('other.slug');
      expect(fragments).toContain('other.tagline');
      expect(fragments).toContain('LIKE');
    });

    it('q: LIKE-escapes the term so a typed % searches for a percent sign', async () => {
      const qb = selectQbStub([], 0);
      connections.createQueryBuilder.mockReturnValue(qb);

      await service.list('me', 'all', { q: '100%' });

      const boundSearch = qb
        .andWhere!.mock.calls.map((call) => call[1])
        .find(
          (params): params is { searchPattern: string } =>
            !!params && 'searchPattern' in (params as object),
        );
      expect(boundSearch?.searchPattern).toBe('%100\\%%');
    });

    it('q: pages with offset/limit, never skip/take, because the query joins and orders on the join', async () => {
      const qb = selectQbStub([], 0);
      connections.createQueryBuilder.mockReturnValue(qb);

      const res = await service.list('me', 'all', { q: 'ana', page: 3 });

      expect(qb.offset).toHaveBeenCalledWith(40);
      expect(qb.limit).toHaveBeenCalledWith(20);
      expect(res).toEqual({ items: [], total: 0, page: 3, pageSize: 20 });
    });

    it('sort=alphabetical: orders by the folded profile name, so accents sort with their plain letter', async () => {
      const qb = selectQbStub([], 0);
      connections.createQueryBuilder.mockReturnValue(qb);

      await service.list('me', 'all', { sort: 'alphabetical' });

      const orderExpression = String(qb.orderBy!.mock.calls[0]?.[0]);
      expect(orderExpression).toContain('translate(lower(other.first_name)');
      expect(qb.orderBy).toHaveBeenCalledWith(
        expect.stringContaining('other.first_name'),
        'ASC',
      );
      // A stable tiebreak keeps a row from swapping pages between fetches.
      expect(qb.addOrderBy).toHaveBeenCalledWith('connection.id', 'ASC');
    });

    it('sort=mutuals: ranks by shared connections and keeps the true total', async () => {
      const qb = selectQbStub(
        [acceptedRow('ca', 'a'), acceptedRow('cb', 'b')],
        2,
      );
      connections.createQueryBuilder.mockReturnValue(qb);
      // `a` shares one connection with the viewer (x); `b` shares two (x, y).
      connections.find.mockResolvedValue([
        { requesterId: 'me', addresseeId: 'x', status: 'accepted' },
        { requesterId: 'me', addresseeId: 'y', status: 'accepted' },
        { requesterId: 'a', addresseeId: 'x', status: 'accepted' },
        { requesterId: 'b', addresseeId: 'x', status: 'accepted' },
        { requesterId: 'b', addresseeId: 'y', status: 'accepted' },
      ]);
      profiles.find.mockResolvedValue([
        { userId: 'a', slug: 'a', firstName: 'A', lastName: 'One' },
        { userId: 'b', slug: 'b', firstName: 'B', lastName: 'Two' },
      ]);

      const res = await service.list('me', 'all', { sort: 'mutuals' });

      expect(res.items.map((item) => item.id)).toEqual(['cb', 'ca']);
      expect(res.items[0]?.mutuals).toBe(2);
      expect(res.items[1]?.mutuals).toBe(1);
      expect(res.total).toBe(2);
    });

    it('vouched + q: short-circuits when the viewer has vouched for nobody', async () => {
      vouchService.getActiveVoucheeIds.mockResolvedValue([]);
      const res = await service.list('me', 'vouched', { q: 'ana' });
      expect(connections.createQueryBuilder).not.toHaveBeenCalled();
      expect(res).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
    });
  });

  describe('requestReason on an accepted row (SOC-14)', () => {
    it('reports who sent the request, so the reason can be attributed after acceptance', async () => {
      connections.findAndCount.mockResolvedValue([
        [
          {
            id: 'c1',
            status: ConnectionStatus.Accepted,
            requesterId: 'them',
            addresseeId: 'me',
            introducedBy: null,
            createdAt: new Date(),
            respondedAt: new Date(),
            requestMessage: 'We met at the workshop.',
            requestReason: 'collaborate',
          },
        ],
        1,
      ]);
      profiles.find.mockResolvedValue([
        { userId: 'them', slug: 'them', firstName: 'T', lastName: 'Hem' },
      ]);

      const { items } = await service.list('me', 'all');
      expect(items[0]?.requestReason).toBe('collaborate');
      expect(items[0]?.isRequestedByYou).toBe(false);
    });

    it('marks the viewer as the requester on a connection they started', async () => {
      connections.findAndCount.mockResolvedValue([
        [
          {
            id: 'c1',
            status: ConnectionStatus.Accepted,
            requesterId: 'me',
            addresseeId: 'them',
            introducedBy: null,
            createdAt: new Date(),
            respondedAt: new Date(),
            requestMessage: null,
            requestReason: 'custom:same choir',
          },
        ],
        1,
      ]);
      profiles.find.mockResolvedValue([
        { userId: 'them', slug: 'them', firstName: 'T', lastName: 'Hem' },
      ]);

      const { items } = await service.list('me', 'all');
      expect(items[0]?.isRequestedByYou).toBe(true);
    });
  });

  describe('private connection notes (SOC-14)', () => {
    const sharedRow = {
      id: 'c1',
      status: ConnectionStatus.Accepted,
      requesterId: 'me',
      addresseeId: 'them',
      introducedBy: null,
      createdAt: new Date(),
      respondedAt: new Date(),
      requestMessage: null,
      requestReason: null,
    };

    beforeEach(() => {
      connections.findAndCount.mockResolvedValue([[sharedRow], 1]);
      profiles.find.mockResolvedValue([
        { userId: 'them', slug: 'them', firstName: 'T', lastName: 'Hem' },
      ]);
    });

    it('surfaces the viewer own note, read under their own author id', async () => {
      connectionNotes.find.mockResolvedValue([
        { connectionId: 'c1', authorId: 'me', body: 'Met at the choir night.' },
      ]);

      const { items } = await service.list('me', 'all');

      expect(connectionNotes.find).toHaveBeenCalledWith({
        where: { authorId: 'me', connectionId: In(['c1']) },
      });
      expect(items[0]?.note).toBe('Met at the choir night.');
    });

    it('never leaks a note to the other party: their page reads under THEIR author id and comes back empty', async () => {
      // The same connection, viewed by the other member. The note written by
      // `me` is not loaded at all, so nothing downstream can map it.
      connectionNotes.find.mockResolvedValue([]);

      const { items } = await service.list('them', 'all');

      expect(connectionNotes.find).toHaveBeenCalledWith({
        where: { authorId: 'them', connectionId: In(['c1']) },
      });
      const [whereClause] = connectionNotes.find.mock.calls.map(
        (call) => (call[0] as { where: { authorId: string } }).where,
      );
      expect(whereClause?.authorId).toBe('them');
      expect(items[0]?.note).toBeNull();
    });

    it('setNote: stores the note as plain text for a party to the connection', async () => {
      connections.findOne.mockResolvedValue(sharedRow);

      const res = await service.setNote('c1', 'me', '  <b>Runs the choir</b> ');

      expect(res).toEqual({ note: 'Runs the choir' });
      expect(connectionNotes.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: 'c1',
          authorId: 'me',
          body: 'Runs the choir',
        }),
        { conflictPaths: ['connectionId', 'authorId'] },
      );
    });

    it('setNote: an empty body clears the note instead of storing a blank', async () => {
      connections.findOne.mockResolvedValue(sharedRow);

      const res = await service.setNote('c1', 'me', '   ');

      expect(res).toEqual({ note: null });
      expect(connectionNotes.delete).toHaveBeenCalledWith({
        connectionId: 'c1',
        authorId: 'me',
      });
      expect(connectionNotes.upsert).not.toHaveBeenCalled();
    });

    it('setNote: a member who is not a party to the connection cannot annotate it', async () => {
      connections.findOne.mockResolvedValue(sharedRow);

      await expect(service.setNote('c1', 'stranger', 'hi')).rejects.toThrow(
        ForbiddenException,
      );
      expect(connectionNotes.upsert).not.toHaveBeenCalled();
    });

    it('setNote: 404s on a connection that does not exist', async () => {
      connections.findOne.mockResolvedValue(null);

      await expect(service.setNote('nope', 'me', 'hi')).rejects.toThrow(
        NotFoundException,
      );
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

  describe('mutualMembers', () => {
    // `mutualMembers` makes two `connections.find` calls in sequence:
    //  1. `acceptedConnectionUserIdsOrdered('them')` — `them`'s accepted
    //     connections, oldest-`respondedAt`-first (the real query's
    //     `ORDER BY respondedAt ASC, id ASC`; this mock supplies rows already
    //     in that order, since the fake repo doesn't apply real SQL ordering).
    //  2. `acceptedConnectionsAmong('me', <those ids>)` — which of them the
    //     viewer ('me') is also accepted-connected to.
    // Order is deterministic through BOTH steps: which of `them`'s connections
    // are mutual is decided by (1)'s order (oldest shared connection first),
    // and is never reshuffled by (2) since acceptedConnectionsAmong only
    // narrows a Set (membership test), the final list is filtered from (1)'s
    // ordered array, not rebuilt from the Set.

    it('orders mutuals by how long `them` has known each one, oldest first, and is unaffected by the profiles lookup row order', async () => {
      connections.find
        // `them`'s accepted connections, oldest first: a, then b, then c.
        .mockResolvedValueOnce([
          { requesterId: 'them', addresseeId: 'a', status: 'accepted' },
          { requesterId: 'them', addresseeId: 'b', status: 'accepted' },
          { requesterId: 'them', addresseeId: 'c', status: 'accepted' },
        ])
        // Of [a, b, c], the viewer ('me') is connected to a and c, not b.
        .mockResolvedValueOnce([
          { requesterId: 'me', addresseeId: 'a', status: 'accepted' },
          { requesterId: 'c', addresseeId: 'me', status: 'accepted' },
        ]);
      // Deliberately returned in the REVERSE of the expected [a, c] order, to
      // prove the final `members` order comes from the mutuals list, not from
      // `Repository.find`'s (unstable, no-ORDER-BY) row order.
      profiles.find.mockResolvedValue([
        { userId: 'c', slug: 'cleo', firstName: 'Cleo', lastName: 'Cruz' },
        { userId: 'a', slug: 'ana', firstName: 'Ana', lastName: 'Alvarez' },
      ]);

      const result = await service.mutualMembers('me', 'them');

      expect(result).toEqual({
        count: 2,
        members: [
          { slug: 'ana', firstName: 'Ana', lastName: 'Alvarez' },
          { slug: 'cleo', firstName: 'Cleo', lastName: 'Cruz' },
        ],
      });
      expect(profiles.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: In(['a', 'c']) } }),
      );
    });

    it('returns the full count but caps the returned members at `limit`', async () => {
      connections.find
        .mockResolvedValueOnce([
          { requesterId: 'them', addresseeId: 'a', status: 'accepted' },
          { requesterId: 'them', addresseeId: 'b', status: 'accepted' },
          { requesterId: 'them', addresseeId: 'c', status: 'accepted' },
        ])
        // All three are mutual this time.
        .mockResolvedValueOnce([
          { requesterId: 'me', addresseeId: 'a', status: 'accepted' },
          { requesterId: 'me', addresseeId: 'b', status: 'accepted' },
          { requesterId: 'me', addresseeId: 'c', status: 'accepted' },
        ]);
      profiles.find.mockResolvedValue([
        { userId: 'a', slug: 'ana', firstName: 'Ana', lastName: 'Alvarez' },
        { userId: 'b', slug: 'bo', firstName: 'Bo', lastName: 'Byrne' },
      ]);

      const result = await service.mutualMembers('me', 'them', 2);

      expect(result.count).toBe(3);
      expect(result.members).toHaveLength(2);
      // Only the top-2 ids (a, b) are ever looked up — c's profile is never
      // fetched.
      expect(profiles.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: In(['a', 'b']) } }),
      );
    });

    it('short-circuits to {count: 0, members: []} when `them` has no accepted connections, skipping the profile lookup', async () => {
      connections.find.mockResolvedValueOnce([]);

      const result = await service.mutualMembers('me', 'them');

      expect(result).toEqual({ count: 0, members: [] });
      expect(profiles.find).not.toHaveBeenCalled();
      // Only the first `connections.find` (them's connections) ran — no
      // second call to test them against the viewer's connections.
      expect(connections.find).toHaveBeenCalledTimes(1);
    });

    it("short-circuits to {count: 0, members: []} when none of `them`'s connections are mutual with the viewer", async () => {
      connections.find
        .mockResolvedValueOnce([
          { requesterId: 'them', addresseeId: 'a', status: 'accepted' },
        ])
        .mockResolvedValueOnce([]); // viewer shares none of them
      const result = await service.mutualMembers('me', 'them');
      expect(result).toEqual({ count: 0, members: [] });
      expect(profiles.find).not.toHaveBeenCalled();
    });
  });
});
