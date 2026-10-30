import { HttpException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager } from 'typeorm';
import { MediaCropService } from '../media-crops/media-crops.service';
import {
  ListingTeamInitiator,
  ListingTeamMember,
  ListingTeamMemberStatus,
} from './entities/listing-team-member.entity';
import { Listing } from './entities/listing.entity';
import { ListingTeamMemberLinksService } from './listing-team-member-links.service';
import { listingTeamError } from './listing-team.constants';
import { LISTING_TEAM_MEMBER_ACCEPTED } from './listing-team.events';
import {
  assertMemberAcceptedRoom,
  lockMemberCap,
} from './listing-team-write-rules';

// The two member-cap helpers have their own spec in the write-rules suite, so
// here they are recorded and can be told to refuse.
jest.mock('./listing-team-write-rules', () => ({
  ...jest.requireActual<object>('./listing-team-write-rules'),
  lockMemberCap: jest.fn(),
  assertMemberAcceptedRoom: jest.fn(),
}));

const USER_ID = 'member-user-1';
const OTHER_USER_ID = 'member-user-2';
const LISTING_ID = 'listing-1';
const LISTING_OWNER_ID = 'listing-owner-1';

interface ListingFactsFixture {
  id: string;
  ref: string;
  slug: string;
  name: string;
  owner_id: string | null;
  is_publicly_visible: boolean;
}

/** Everything the fake database knows. Each test changes what it needs. */
interface World {
  listingFacts: ListingFactsFixture | null;
  isMemberEligible: boolean;
  isBlocked: boolean;
  nextPosition: number;
  teamRows: Map<string, ListingTeamMember>;
  invitesReceived: ListingTeamMember[];
  accepted: ListingTeamMember[];
  pendingInviteCount: number;
  listings: Listing[];
  liveListingIds: string[];
}

function makeListing(overrides: Partial<Listing> = {}): Listing {
  return {
    id: LISTING_ID,
    ref: 'QPL-2026-0001',
    slug: 'casa-t',
    name: 'Casa T',
    ownerId: LISTING_OWNER_ID,
    cats: ['space'],
    hood: 'Anjos',
    city: 'Lisbon',
    photoGallery: [],
    photos: { wide: '', d1: '', d2: '', vibe: '' },
    ...overrides,
  } as unknown as Listing;
}

function makeRow(
  overrides: Partial<ListingTeamMember> = {},
): ListingTeamMember {
  return {
    id: 'row-1',
    listingId: LISTING_ID,
    subprofileId: null,
    userId: USER_ID,
    roleLabel: 'Barista',
    status: ListingTeamMemberStatus.Pending,
    initiatedBy: ListingTeamInitiator.Listing,
    requestedByUserId: 'inviting-user-1',
    answeredAt: null,
    position: null,
    createdAt: new Date('2026-10-30T09:00:00.000Z'),
    updatedAt: new Date('2026-10-30T09:00:00.000Z'),
    ...overrides,
  };
}

function makeWorld(): World {
  return {
    listingFacts: {
      id: LISTING_ID,
      ref: 'QPL-2026-0001',
      slug: 'casa-t',
      name: 'Casa T',
      owner_id: LISTING_OWNER_ID,
      is_publicly_visible: true,
    },
    isMemberEligible: true,
    isBlocked: false,
    nextPosition: 1,
    teamRows: new Map(),
    invitesReceived: [],
    accepted: [],
    pendingInviteCount: 0,
    listings: [makeListing()],
    liveListingIds: [LISTING_ID],
  };
}

interface FindOptions {
  where?: Record<string, unknown>;
  lock?: unknown;
  take?: number;
}

/** A manager over the fake world that records every lock and write in one log. */
function buildManager(world: World, log: string[]) {
  const query = jest.fn((sql: string) => {
    if (sql.includes('FROM "listings" WHERE "id" = $1 FOR UPDATE')) {
      log.push('lock listing');
      return Promise.resolve([]);
    }
    if (sql.includes('"is_publicly_visible"')) {
      return Promise.resolve(world.listingFacts ? [world.listingFacts] : []);
    }
    if (sql.includes('"is_blocked"')) {
      return Promise.resolve([{ is_blocked: world.isBlocked }]);
    }
    if (sql.includes('"next_position"')) {
      return Promise.resolve([{ next_position: world.nextPosition }]);
    }
    if (sql.includes('"is_eligible"')) {
      log.push('read member eligibility');
      return Promise.resolve([{ is_eligible: world.isMemberEligible }]);
    }
    if (sql.includes('= ANY($1::uuid[])')) {
      return Promise.resolve(world.liveListingIds.map((id) => ({ id })));
    }
    return Promise.resolve([]);
  });
  const findOne = jest.fn((entity: unknown, options: FindOptions) => {
    const where = options.where ?? {};
    if (entity === ListingTeamMember && typeof where.id === 'string') {
      if (options.lock) log.push('lock team row');
      const row = world.teamRows.get(where.id);
      return Promise.resolve(row ? { ...row } : null);
    }
    return Promise.resolve(null);
  });
  const count = jest.fn(() => Promise.resolve(world.pendingInviteCount));
  const find = jest.fn((entity: unknown, options: FindOptions) => {
    if (entity === Listing) {
      return Promise.resolve(world.listings);
    }
    const rows =
      options.where?.status === ListingTeamMemberStatus.Accepted
        ? world.accepted
        : world.invitesReceived;
    return Promise.resolve(
      options.take === undefined ? rows : rows.slice(0, options.take),
    );
  });
  const update = jest.fn(
    (_entity: unknown, _criteria: unknown, _values: unknown) => {
      log.push('update');
      return Promise.resolve({ affected: 1 });
    },
  );
  return { query, findOne, count, find, update };
}

type ManagerMock = ReturnType<typeof buildManager>;

interface Harness {
  service: ListingTeamMemberLinksService;
  world: World;
  manager: ManagerMock;
  log: string[];
  emit: jest.Mock;
}

function buildHarness(): Harness {
  const world = makeWorld();
  const log: string[] = [];
  const manager = buildManager(world, log);
  const transaction = jest.fn(
    async (work: (transactionManager: EntityManager) => Promise<unknown>) => {
      const result = await work(manager as unknown as EntityManager);
      log.push('commit');
      return result;
    },
  );
  const dataSource = { manager, transaction } as unknown as DataSource;
  const mediaCropService = {
    getMany: jest.fn().mockResolvedValue(new Map()),
  } as unknown as MediaCropService;
  const emit = jest.fn((eventName: string) => {
    log.push(`emit ${eventName}`);
    return true;
  });
  const eventEmitter = { emit } as unknown as EventEmitter2;
  const service = new ListingTeamMemberLinksService(
    dataSource,
    mediaCropService,
    eventEmitter,
  );
  return { service, world, manager, log, emit };
}

/** Runs the call and answers the body of the HttpException it threw. */
async function refusalOf(call: Promise<unknown>): Promise<{
  statusCode?: number;
  code?: string;
}> {
  try {
    await call;
  } catch (error) {
    if (error instanceof HttpException) {
      return error.getResponse() as { statusCode?: number; code?: string };
    }
    throw error;
  }
  throw new Error('expected the call to refuse');
}

describe('ListingTeamMemberLinksService', () => {
  beforeEach(() => {
    jest.mocked(lockMemberCap).mockReset().mockResolvedValue(undefined);
    jest
      .mocked(assertMemberAcceptedRoom)
      .mockReset()
      .mockResolvedValue(undefined);
  });

  describe('list', () => {
    it('lists invites newest first and accepted rows with the listing and its live flag', async () => {
      const harness = buildHarness();
      harness.world.pendingInviteCount = 1;
      harness.world.invitesReceived = [makeRow()];
      harness.world.accepted = [
        makeRow({
          id: 'row-2',
          status: ListingTeamMemberStatus.Accepted,
          position: 3,
          answeredAt: new Date('2026-10-30T10:00:00.000Z'),
        }),
      ];
      const list = await harness.service.list(USER_ID);
      expect(list.awaitingYouCount).toBe(1);
      expect(list.invitesReceived).toHaveLength(1);
      expect(list.invitesReceived[0]).toMatchObject({
        id: 'row-1',
        status: 'pending',
        initiatedBy: 'listing',
        roleLabel: 'Barista',
        isListingLive: true,
        listing: { slug: 'casa-t' },
      });
      expect(list.accepted.map((row) => row.id)).toEqual(['row-2']);
      expect(harness.manager.find).toHaveBeenCalledWith(
        ListingTeamMember,
        expect.objectContaining({
          where: { userId: USER_ID, status: ListingTeamMemberStatus.Accepted },
          order: { answeredAt: 'ASC', id: 'ASC' },
        }),
      );
      expect(harness.manager.find).toHaveBeenCalledWith(
        ListingTeamMember,
        expect.objectContaining({
          order: { createdAt: 'DESC', id: 'DESC' },
          take: 100,
        }),
      );
    });

    it('flags a listing hidden from the public and never carries a user id', async () => {
      const harness = buildHarness();
      harness.world.invitesReceived = [makeRow()];
      harness.world.liveListingIds = [];
      const list = await harness.service.list(USER_ID);
      expect(list.invitesReceived[0]?.isListingLive).toBe(false);
      const wire = JSON.stringify(list);
      expect(wire).not.toContain(USER_ID);
      expect(wire).not.toContain('inviting-user-1');
    });

    it('answers empty lists with no listing query when nothing is linked', async () => {
      const harness = buildHarness();
      const list = await harness.service.list(USER_ID);
      expect(list).toEqual({
        awaitingYouCount: 0,
        invitesReceived: [],
        accepted: [],
      });
      expect(harness.manager.find).not.toHaveBeenCalledWith(
        Listing,
        expect.anything(),
      );
    });
  });

  describe('accept', () => {
    it('accepts at the end of the team, emits after commit and carries no user id', async () => {
      const harness = buildHarness();
      harness.world.teamRows.set('row-1', makeRow());
      harness.world.nextPosition = 4;
      const row = await harness.service.accept(USER_ID, 'row-1');
      expect(row.status).toBe('accepted');
      expect(row.answeredAt).not.toBeNull();
      expect(row.isListingLive).toBe(true);
      expect(JSON.stringify(row)).not.toContain(USER_ID);
      expect(JSON.stringify(row)).not.toContain('inviting-user-1');
      expect(harness.manager.update).toHaveBeenCalledWith(
        ListingTeamMember,
        { id: 'row-1' },
        {
          status: ListingTeamMemberStatus.Accepted,
          position: 4,
          answeredAt: expect.any(Date),
        },
      );
      expect(lockMemberCap).toHaveBeenCalledWith(expect.anything(), USER_ID);
      expect(assertMemberAcceptedRoom).toHaveBeenCalledWith(
        expect.anything(),
        LISTING_ID,
        USER_ID,
      );
      expect(harness.emit).toHaveBeenCalledTimes(1);
      expect(harness.emit).toHaveBeenCalledWith(LISTING_TEAM_MEMBER_ACCEPTED, {
        memberId: 'row-1',
        actingUserId: USER_ID,
      });
      expect(harness.log.indexOf('commit')).toBeLessThan(
        harness.log.indexOf(`emit ${LISTING_TEAM_MEMBER_ACCEPTED}`),
      );
    });

    it('locks the listing before the team row', async () => {
      const harness = buildHarness();
      harness.world.teamRows.set('row-1', makeRow());
      await harness.service.accept(USER_ID, 'row-1');
      expect(harness.log.indexOf('lock listing')).toBeLessThan(
        harness.log.indexOf('lock team row'),
      );
    });

    it('answers link not found when the listing owner has a block with the member', async () => {
      const harness = buildHarness();
      harness.world.teamRows.set('row-1', makeRow());
      harness.world.isBlocked = true;
      const refusal = await refusalOf(harness.service.accept(USER_ID, 'row-1'));
      expect(refusal.statusCode).toBe(404);
      expect(refusal.code).toBe('listing_team_link_not_found');
      expect(JSON.stringify(refusal)).not.toMatch(/block/i);
      expect(harness.manager.update).not.toHaveBeenCalled();
      expect(harness.emit).not.toHaveBeenCalled();
    });

    it('refuses an accept of a member who is no longer eligible with 422', async () => {
      const harness = buildHarness();
      harness.world.teamRows.set('row-1', makeRow());
      harness.world.isMemberEligible = false;
      const refusal = await refusalOf(harness.service.accept(USER_ID, 'row-1'));
      expect(refusal.statusCode).toBe(422);
      expect(refusal.code).toBe('listing_team_member_ineligible');
      expect(harness.manager.update).not.toHaveBeenCalled();
      expect(harness.emit).not.toHaveBeenCalled();
    });

    it('refuses an accept of an invite from a listing gone private with listing not live', async () => {
      const harness = buildHarness();
      harness.world.teamRows.set('row-1', makeRow());
      harness.world.listingFacts = {
        ...harness.world.listingFacts!,
        is_publicly_visible: false,
      };
      const refusal = await refusalOf(harness.service.accept(USER_ID, 'row-1'));
      expect(refusal.statusCode).toBe(409);
      expect(refusal.code).toBe('listing_team_listing_not_live');
      expect(harness.manager.update).not.toHaveBeenCalled();
    });

    it('refuses an accept once the listing has 40 accepted members', async () => {
      const harness = buildHarness();
      harness.world.teamRows.set('row-1', makeRow());
      jest
        .mocked(assertMemberAcceptedRoom)
        .mockRejectedValueOnce(listingTeamError('listing_team_full'));
      const refusal = await refusalOf(harness.service.accept(USER_ID, 'row-1'));
      expect(refusal.statusCode).toBe(409);
      expect(refusal.code).toBe('listing_team_full');
      expect(harness.manager.update).not.toHaveBeenCalled();
      expect(harness.emit).not.toHaveBeenCalled();
    });

    it('refuses an accept once the member is on 10 teams', async () => {
      const harness = buildHarness();
      harness.world.teamRows.set('row-1', makeRow());
      jest
        .mocked(assertMemberAcceptedRoom)
        .mockRejectedValueOnce(listingTeamError('listing_team_member_full'));
      const refusal = await refusalOf(harness.service.accept(USER_ID, 'row-1'));
      expect(refusal.statusCode).toBe(409);
      expect(refusal.code).toBe('listing_team_member_full');
      expect(harness.manager.update).not.toHaveBeenCalled();
      expect(harness.emit).not.toHaveBeenCalled();
    });

    it('answers link not found to a row of another member and to an unknown id', async () => {
      const harness = buildHarness();
      harness.world.teamRows.set('row-1', makeRow({ userId: OTHER_USER_ID }));
      const calls: (() => Promise<unknown>)[] = [
        () => harness.service.accept(USER_ID, 'row-1'),
        () => harness.service.decline(USER_ID, 'row-1'),
        () => harness.service.leave(USER_ID, 'row-1'),
        () => harness.service.accept(USER_ID, 'row-unknown'),
        () => harness.service.decline(USER_ID, 'row-unknown'),
        () => harness.service.leave(USER_ID, 'row-unknown'),
      ];
      for (const call of calls) {
        const refusal = await refusalOf(call());
        expect(refusal.statusCode).toBe(404);
        expect(refusal.code).toBe('listing_team_link_not_found');
      }
      expect(harness.manager.update).not.toHaveBeenCalled();
      expect(harness.emit).not.toHaveBeenCalled();
    });

    it('answers link not found to a persona row', async () => {
      const harness = buildHarness();
      harness.world.teamRows.set(
        'row-1',
        makeRow({
          userId: null,
          subprofileId: 'persona-1',
          initiatedBy: ListingTeamInitiator.Persona,
        }),
      );
      const refusal = await refusalOf(harness.service.accept(USER_ID, 'row-1'));
      expect(refusal.code).toBe('listing_team_link_not_found');
    });

    it('refuses an accept of an answered invite with not pending', async () => {
      const harness = buildHarness();
      harness.world.teamRows.set(
        'row-1',
        makeRow({ status: ListingTeamMemberStatus.Declined }),
      );
      const refusal = await refusalOf(harness.service.accept(USER_ID, 'row-1'));
      expect(refusal.statusCode).toBe(409);
      expect(refusal.code).toBe('listing_team_not_pending');
      expect(harness.manager.update).not.toHaveBeenCalled();
    });
  });

  describe('decline and leave', () => {
    it('declines a pending invite quietly and records the answer time that starts the cooldown', async () => {
      const harness = buildHarness();
      harness.world.teamRows.set('row-1', makeRow());
      await harness.service.decline(USER_ID, 'row-1');
      expect(harness.manager.update).toHaveBeenCalledWith(
        ListingTeamMember,
        { id: 'row-1' },
        {
          status: ListingTeamMemberStatus.Declined,
          answeredAt: expect.any(Date),
        },
      );
      expect(harness.emit).not.toHaveBeenCalled();
    });

    it('refuses to decline an answered invite with not pending', async () => {
      const harness = buildHarness();
      harness.world.teamRows.set(
        'row-1',
        makeRow({
          status: ListingTeamMemberStatus.Accepted,
          position: 1,
        }),
      );
      const refusal = await refusalOf(
        harness.service.decline(USER_ID, 'row-1'),
      );
      expect(refusal.code).toBe('listing_team_not_pending');
      expect(harness.manager.update).not.toHaveBeenCalled();
    });

    it('leaves an accepted team quietly and clears the position', async () => {
      const harness = buildHarness();
      harness.world.teamRows.set(
        'row-1',
        makeRow({ status: ListingTeamMemberStatus.Accepted, position: 2 }),
      );
      await harness.service.leave(USER_ID, 'row-1');
      expect(harness.manager.update).toHaveBeenCalledWith(
        ListingTeamMember,
        { id: 'row-1' },
        { status: ListingTeamMemberStatus.Left, position: null },
      );
      expect(harness.emit).not.toHaveBeenCalled();
    });

    it('refuses to leave a row that is not accepted with not accepted', async () => {
      const harness = buildHarness();
      harness.world.teamRows.set('row-1', makeRow());
      const refusal = await refusalOf(harness.service.leave(USER_ID, 'row-1'));
      expect(refusal.statusCode).toBe(409);
      expect(refusal.code).toBe('listing_team_not_accepted');
      expect(harness.manager.update).not.toHaveBeenCalled();
    });
  });
});
