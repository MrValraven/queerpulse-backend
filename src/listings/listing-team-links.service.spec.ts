import { HttpException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager } from 'typeorm';
import { MediaCropService } from '../media-crops/media-crops.service';
import { SubprofileMembershipService } from '../subprofiles/subprofile-membership.service';
import {
  ListingTeamInitiator,
  ListingTeamMember,
  ListingTeamMemberStatus,
} from './entities/listing-team-member.entity';
import { Listing } from './entities/listing.entity';
import { ListingTeamLinksService } from './listing-team-links.service';
import { LISTING_TEAM_LISTING_COLUMNS } from './listing-team-response';
import {
  LISTING_TEAM_ACCEPTED,
  LISTING_TEAM_REQUESTED,
} from './listing-team.events';
import {
  notBlockedEitherWaySql,
  publiclyVisibleListingSql,
} from './listing-team-visibility';

const SUBPROFILE_ID = 'persona-1';
const USER_ID = 'caller-user-1';
const LISTING_ID = 'listing-1';
const LISTING_OWNER_ID = 'listing-owner-1';
/** The persona's owner when the caller is a co-owner of the persona. */
const PERSONA_OWNER_ID = 'persona-owner-2';
const NEW_MEMBER_ID = 'member-new';

interface ListingFactsFixture {
  id: string;
  ref: string;
  slug: string;
  name: string;
  owner_id: string | null;
  is_publicly_visible: boolean;
}

interface PersonaFactsFixture {
  id: string;
  user_id: string;
  is_eligible: boolean;
}

/** Everything the fake database knows. Each test changes what it needs. */
interface World {
  listingFacts: ListingFactsFixture | null;
  isPersonaRowPresent: boolean;
  personaFacts: PersonaFactsFixture | null;
  isBlocked: boolean;
  /** A block either way that any block query naming both members finds. */
  blockedPair: [string, string] | null;
  isManager: boolean;
  livePairRow: ListingTeamMember | null;
  acceptedOnListing: number;
  acceptedOfPersona: number;
  pendingOnListing: number;
  pendingRequestsOfPersona: number;
  invitesReceivedCount: number;
  nextPosition: number;
  teamRows: Map<string, ListingTeamMember>;
  invitesReceived: ListingTeamMember[];
  requestsSent: ListingTeamMember[];
  accepted: ListingTeamMember[];
  listings: Listing[];
  liveListingIds: string[];
  candidateRows: { id: string; team_status: string | null }[];
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
    timezone: 'Europe/Lisbon',
    blurb: 'A community house.',
    tagline: '',
    tags: [],
    price: '',
    badge: '',
    photoGallery: [],
    alt: { wide: '', d1: '', d2: '', vibe: '' },
    photos: { wide: '', d1: '', d2: '', vibe: '' },
    hours: {},
    hoursExceptions: [],
    hoursNote: '',
    langs: [],
    whatItIs: [],
    goodFor: [],
    services: [],
    menu: { sections: [], file: null, link: '' },
    pricingMode: 'services',
    accessibilityAnswers: {},
    accessibilityNote: '',
    social: {},
    address: 'R. dos Anjos 1',
    online: false,
    latitude: null,
    longitude: null,
    ownerName: 'Ana Silva',
    ownerRole: '',
    ownerBio: '',
    memberFirst: 'Ana',
    visibility: 'anon',
    linkToProfile: false,
    movedToListingId: null,
    safeSpaceStatus: 'none',
    safeSpaceTier: null,
    safeSpaceVerifier: '',
    safeSpaceReVerifiedAt: null,
    safeSpaceSub: '',
    safeSpacePromises: [],
    safeSpaceVouches: [],
    safeSpaceRemoval: null,
    ...overrides,
  } as unknown as Listing;
}

function makeMember(
  overrides: Partial<ListingTeamMember> = {},
): ListingTeamMember {
  return {
    id: 'member-1',
    listingId: LISTING_ID,
    subprofileId: SUBPROFILE_ID,
    roleLabel: null,
    status: ListingTeamMemberStatus.Pending,
    initiatedBy: ListingTeamInitiator.Listing,
    requestedByUserId: 'inviting-user-1',
    answeredAt: null,
    position: null,
    createdAt: new Date('2026-10-18T09:00:00.000Z'),
    updatedAt: new Date('2026-10-18T09:00:00.000Z'),
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
    isPersonaRowPresent: true,
    personaFacts: {
      id: SUBPROFILE_ID,
      user_id: USER_ID,
      is_eligible: true,
    },
    isBlocked: false,
    blockedPair: null,
    isManager: false,
    livePairRow: null,
    acceptedOnListing: 0,
    acceptedOfPersona: 0,
    pendingOnListing: 0,
    pendingRequestsOfPersona: 0,
    invitesReceivedCount: 0,
    nextPosition: 1,
    teamRows: new Map(),
    invitesReceived: [],
    requestsSent: [],
    accepted: [],
    listings: [makeListing()],
    liveListingIds: [LISTING_ID],
    candidateRows: [],
  };
}

interface FindOptions {
  where?: Record<string, unknown>;
  lock?: unknown;
  take?: number;
}

/** A manager over the fake world that records every lock and write in one log. */
function buildManager(world: World, log: string[]) {
  const insertedValues: unknown[][] = [];
  const query = jest.fn((sql: string, parameters: unknown[] = []) => {
    if (sql.includes('FROM "listings" WHERE "id" = $1 FOR UPDATE')) {
      log.push('lock listing');
      return Promise.resolve([]);
    }
    if (sql.includes('FROM "subprofiles" WHERE "id" = $1 FOR UPDATE')) {
      log.push('lock persona');
      return Promise.resolve(
        world.isPersonaRowPresent ? [{ id: SUBPROFILE_ID }] : [],
      );
    }
    if (sql.includes('"is_publicly_visible"')) {
      return Promise.resolve(world.listingFacts ? [world.listingFacts] : []);
    }
    if (sql.includes('"is_eligible"')) {
      log.push('read persona facts');
      return Promise.resolve(world.personaFacts ? [world.personaFacts] : []);
    }
    if (sql.includes('SELECT "persona"."user_id" FROM "subprofiles"')) {
      return Promise.resolve(
        world.personaFacts ? [{ user_id: world.personaFacts.user_id }] : [],
      );
    }
    if (sql.includes('"is_blocked"')) {
      const blockedPair = world.blockedPair;
      const isPairBlocked =
        blockedPair !== null &&
        blockedPair.every((blockedUserId) =>
          parameters.includes(blockedUserId),
        );
      return Promise.resolve([
        { is_blocked: world.isBlocked || isPairBlocked },
      ]);
    }
    if (sql.includes('"is_manager"')) {
      return Promise.resolve([{ is_manager: world.isManager }]);
    }
    if (sql.includes('"next_position"')) {
      return Promise.resolve([{ next_position: world.nextPosition }]);
    }
    if (sql.includes('INSERT INTO "listing_team_members"')) {
      log.push('insert');
      insertedValues.push(parameters);
      return Promise.resolve([{ id: NEW_MEMBER_ID }]);
    }
    if (sql.includes('= ANY($1::uuid[])')) {
      return Promise.resolve(world.liveListingIds.map((id) => ({ id })));
    }
    if (sql.includes('ILIKE')) {
      return Promise.resolve(world.candidateRows);
    }
    return Promise.resolve([]);
  });
  const findOne = jest.fn((entity: unknown, options: FindOptions) => {
    const where = options.where ?? {};
    if (entity === ListingTeamMember && options.lock) {
      log.push('lock team row');
      const row = world.teamRows.get(where.id as string);
      return Promise.resolve(row ? { ...row } : null);
    }
    if (entity === ListingTeamMember && typeof where.id === 'string') {
      const row = world.teamRows.get(where.id);
      return Promise.resolve(row ? { ...row } : null);
    }
    if (entity === ListingTeamMember && where.status !== undefined) {
      return Promise.resolve(world.livePairRow);
    }
    return Promise.resolve(null);
  });
  const findOneOrFail = jest.fn(() => {
    const parameters = insertedValues[insertedValues.length - 1] ?? [];
    return Promise.resolve(
      makeMember({
        id: NEW_MEMBER_ID,
        listingId: parameters[0] as string,
        subprofileId: parameters[1] as string,
        initiatedBy: parameters[2] as ListingTeamInitiator,
        requestedByUserId: parameters[3] as string,
        roleLabel: parameters[4] as string | null,
        status: parameters[5] as ListingTeamMemberStatus,
        position: parameters[6] as number | null,
        answeredAt: parameters[7] as Date | null,
      }),
    );
  });
  const count = jest.fn((_entity: unknown, options: FindOptions) => {
    const where = options.where ?? {};
    if (where.status === ListingTeamMemberStatus.Accepted) {
      return Promise.resolve(
        where.listingId !== undefined
          ? world.acceptedOnListing
          : world.acceptedOfPersona,
      );
    }
    if (where.listingId !== undefined) {
      return Promise.resolve(world.pendingOnListing);
    }
    if (where.initiatedBy === ListingTeamInitiator.Persona) {
      return Promise.resolve(world.pendingRequestsOfPersona);
    }
    return Promise.resolve(world.invitesReceivedCount);
  });
  const find = jest.fn((entity: unknown, options: FindOptions) => {
    if (entity === Listing) {
      return Promise.resolve(world.listings);
    }
    const where = options.where ?? {};
    let rows: ListingTeamMember[];
    if (where.status === ListingTeamMemberStatus.Accepted) {
      rows = world.accepted;
    } else if (where.initiatedBy === ListingTeamInitiator.Listing) {
      rows = world.invitesReceived;
    } else {
      rows = world.requestsSent;
    }
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
  return { query, findOne, findOneOrFail, count, find, update };
}

type ManagerMock = ReturnType<typeof buildManager>;

interface Harness {
  service: ListingTeamLinksService;
  world: World;
  manager: ManagerMock;
  log: string[];
  isMember: jest.Mock;
  emit: jest.Mock;
  transaction: jest.Mock;
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
  const isMember = jest.fn().mockResolvedValue(true);
  const membership = { isMember } as unknown as SubprofileMembershipService;
  const mediaCropService = {
    getMany: jest.fn().mockResolvedValue(new Map()),
  } as unknown as MediaCropService;
  const emit = jest.fn((eventName: string) => {
    log.push(`emit ${eventName}`);
    return true;
  });
  const eventEmitter = { emit } as unknown as EventEmitter2;
  const service = new ListingTeamLinksService(
    dataSource,
    membership,
    mediaCropService,
    eventEmitter,
  );
  return { service, world, manager, log, isMember, emit, transaction };
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

const requestBody = { listingId: LISTING_ID };

describe('ListingTeamLinksService', () => {
  describe('seat check', () => {
    it('answers persona not found to a caller without a seat, and for an unknown persona id', async () => {
      const harness = buildHarness();
      harness.isMember.mockResolvedValue(false);
      const { service } = harness;
      const calls: (() => Promise<unknown>)[] = [
        () => service.listForPersona(SUBPROFILE_ID, USER_ID),
        () => service.searchCandidates(SUBPROFILE_ID, USER_ID, 'casa'),
        () => service.request(SUBPROFILE_ID, USER_ID, requestBody),
        () => service.accept(SUBPROFILE_ID, USER_ID, 'member-1'),
        () => service.decline(SUBPROFILE_ID, USER_ID, 'member-1'),
        () => service.cancel(SUBPROFILE_ID, USER_ID, 'member-1'),
        () => service.leave(SUBPROFILE_ID, USER_ID, 'member-1'),
        () => service.listForPersona('unknown-persona', USER_ID),
      ];
      for (const call of calls) {
        const refusal = await refusalOf(call());
        expect(refusal.statusCode).toBe(404);
        expect(refusal.code).toBe('listing_team_persona_not_found');
      }
      expect(harness.isMember).toHaveBeenCalledWith(USER_ID, SUBPROFILE_ID);
      expect(harness.isMember).toHaveBeenCalledWith(USER_ID, 'unknown-persona');
      expect(harness.transaction).not.toHaveBeenCalled();
      expect(harness.manager.query).not.toHaveBeenCalled();
      expect(harness.manager.find).not.toHaveBeenCalled();
    });
  });

  describe('request', () => {
    it('answers listing not found to a request across a block', async () => {
      const harness = buildHarness();
      harness.world.isBlocked = true;
      const refusal = await refusalOf(
        harness.service.request(SUBPROFILE_ID, USER_ID, requestBody),
      );
      expect(refusal.code).toBe('listing_team_listing_not_found');
      expect(refusal.statusCode).toBe(404);
      expect(harness.log).not.toContain('insert');
      expect(harness.emit).not.toHaveBeenCalled();
    });

    it('refuses a request when the listing owner and the persona owner have a block', async () => {
      const harness = buildHarness();
      harness.world.personaFacts = {
        ...harness.world.personaFacts!,
        user_id: PERSONA_OWNER_ID,
      };
      harness.world.blockedPair = [LISTING_OWNER_ID, PERSONA_OWNER_ID];
      const refusal = await refusalOf(
        harness.service.request(SUBPROFILE_ID, USER_ID, requestBody),
      );
      expect(refusal.statusCode).toBe(404);
      expect(refusal.code).toBe('listing_team_listing_not_found');
      const blockParameters = harness.manager.query.mock.calls
        .filter(([sql]) => sql.includes('"is_blocked"'))
        .map(([, parameters]) => parameters);
      expect(blockParameters).toEqual([
        [USER_ID, LISTING_OWNER_ID],
        [PERSONA_OWNER_ID, LISTING_OWNER_ID],
      ]);
      expect(harness.log).not.toContain('insert');
      expect(harness.emit).not.toHaveBeenCalled();
    });

    it('answers persona not found when the persona row is gone at the lock', async () => {
      const harness = buildHarness();
      harness.world.isPersonaRowPresent = false;
      const refusal = await refusalOf(
        harness.service.request(SUBPROFILE_ID, USER_ID, requestBody),
      );
      expect(refusal.statusCode).toBe(404);
      expect(refusal.code).toBe('listing_team_persona_not_found');
      expect(harness.log).not.toContain('read persona facts');
      expect(harness.log).not.toContain('insert');
    });

    it('answers listing not found to a hidden listing', async () => {
      const harness = buildHarness();
      harness.world.listingFacts = {
        ...harness.world.listingFacts!,
        is_publicly_visible: false,
      };
      const refusal = await refusalOf(
        harness.service.request(SUBPROFILE_ID, USER_ID, requestBody),
      );
      expect(refusal.code).toBe('listing_team_listing_not_found');
      expect(harness.log).not.toContain('insert');
    });

    it('answers listing not found to a listing with no owner', async () => {
      const harness = buildHarness();
      harness.world.listingFacts = {
        ...harness.world.listingFacts!,
        owner_id: null,
      };
      const refusal = await refusalOf(
        harness.service.request(SUBPROFILE_ID, USER_ID, requestBody),
      );
      expect(refusal.code).toBe('listing_team_listing_not_found');
      expect(harness.log).not.toContain('insert');
    });

    it('refuses a request of an ineligible persona with 422', async () => {
      const harness = buildHarness();
      harness.world.personaFacts = {
        ...harness.world.personaFacts!,
        is_eligible: false,
      };
      const refusal = await refusalOf(
        harness.service.request(SUBPROFILE_ID, USER_ID, requestBody),
      );
      expect(refusal.statusCode).toBe(422);
      expect(refusal.code).toBe('listing_team_persona_ineligible');
    });

    it('requests as pending and emits the request after commit', async () => {
      const harness = buildHarness();
      const row = await harness.service.request(
        SUBPROFILE_ID,
        USER_ID,
        requestBody,
      );
      expect(row.id).toBe(NEW_MEMBER_ID);
      expect(row.status).toBe('pending');
      expect(row.initiatedBy).toBe('persona');
      expect(row.listing.id).toBe(LISTING_ID);
      expect(row.isListingLive).toBe(true);
      expect(row.answeredAt).toBeNull();
      expect(JSON.stringify(row)).not.toContain(USER_ID);
      expect(JSON.stringify(row)).not.toContain(LISTING_OWNER_ID);
      expect(harness.emit).toHaveBeenCalledTimes(1);
      expect(harness.emit).toHaveBeenCalledWith(LISTING_TEAM_REQUESTED, {
        memberId: NEW_MEMBER_ID,
        actingUserId: USER_ID,
      });
      expect(harness.log.indexOf('commit')).toBeLessThan(
        harness.log.indexOf(`emit ${LISTING_TEAM_REQUESTED}`),
      );
    });

    it('links a listing the caller manages at once with no notification', async () => {
      const harness = buildHarness();
      harness.world.isManager = true;
      harness.world.nextPosition = 7;
      harness.world.pendingRequestsOfPersona = 10;
      const row = await harness.service.request(
        SUBPROFILE_ID,
        USER_ID,
        requestBody,
      );
      expect(row.status).toBe('accepted');
      expect(row.answeredAt).not.toBeNull();
      const insertCall = harness.manager.query.mock.calls.find(([sql]) =>
        sql.includes('INSERT INTO "listing_team_members"'),
      );
      expect(insertCall?.[1]?.[5]).toBe(ListingTeamMemberStatus.Accepted);
      expect(insertCall?.[1]?.[6]).toBe(7);
      expect(harness.emit).not.toHaveBeenCalled();
    });

    it('refuses the 11th pending request of a persona', async () => {
      const passing = buildHarness();
      passing.world.pendingRequestsOfPersona = 9;
      const row = await passing.service.request(
        SUBPROFILE_ID,
        USER_ID,
        requestBody,
      );
      expect(row.status).toBe('pending');

      const refused = buildHarness();
      refused.world.pendingRequestsOfPersona = 10;
      const refusal = await refusalOf(
        refused.service.request(SUBPROFILE_ID, USER_ID, requestBody),
      );
      expect(refusal.code).toBe('listing_team_persona_requests_full');
      expect(refused.log).not.toContain('insert');
      expect(refused.emit).not.toHaveBeenCalled();
    });

    it('refuses a request once the persona is on 10 teams', async () => {
      const passing = buildHarness();
      passing.world.acceptedOfPersona = 9;
      const row = await passing.service.request(
        SUBPROFILE_ID,
        USER_ID,
        requestBody,
      );
      expect(row.status).toBe('pending');

      const refused = buildHarness();
      refused.world.acceptedOfPersona = 10;
      const refusal = await refusalOf(
        refused.service.request(SUBPROFILE_ID, USER_ID, requestBody),
      );
      expect(refusal.code).toBe('listing_team_persona_full');
      expect(refused.log).not.toContain('insert');
    });
  });

  describe('accept', () => {
    const invite = (overrides: Partial<ListingTeamMember> = {}) =>
      makeMember({
        id: 'member-1',
        initiatedBy: ListingTeamInitiator.Listing,
        status: ListingTeamMemberStatus.Pending,
        ...overrides,
      });

    it('answers link not found to an accept across a block', async () => {
      const harness = buildHarness();
      harness.world.teamRows.set('member-1', invite());
      harness.world.isBlocked = true;
      const refusal = await refusalOf(
        harness.service.accept(SUBPROFILE_ID, USER_ID, 'member-1'),
      );
      expect(refusal.statusCode).toBe(404);
      expect(refusal.code).toBe('listing_team_link_not_found');
      expect(harness.manager.update).not.toHaveBeenCalled();
      expect(harness.emit).not.toHaveBeenCalled();
    });

    it('refuses an accept when the listing owner and the persona owner have a block', async () => {
      const harness = buildHarness();
      harness.world.teamRows.set('member-1', invite());
      harness.world.personaFacts = {
        ...harness.world.personaFacts!,
        user_id: PERSONA_OWNER_ID,
      };
      harness.world.blockedPair = [PERSONA_OWNER_ID, LISTING_OWNER_ID];
      const refusal = await refusalOf(
        harness.service.accept(SUBPROFILE_ID, USER_ID, 'member-1'),
      );
      expect(refusal.statusCode).toBe(404);
      expect(refusal.code).toBe('listing_team_link_not_found');
      expect(harness.manager.update).not.toHaveBeenCalled();
      expect(harness.emit).not.toHaveBeenCalled();
    });

    it('answers persona not found when the persona row is gone at the lock', async () => {
      const harness = buildHarness();
      harness.world.teamRows.set('member-1', invite());
      harness.world.isPersonaRowPresent = false;
      const refusal = await refusalOf(
        harness.service.accept(SUBPROFILE_ID, USER_ID, 'member-1'),
      );
      expect(refusal.statusCode).toBe(404);
      expect(refusal.code).toBe('listing_team_persona_not_found');
      expect(harness.log).not.toContain('read persona facts');
      expect(harness.manager.update).not.toHaveBeenCalled();
    });

    it('refuses an accept of an invite from a listing gone private with listing not live', async () => {
      const harness = buildHarness();
      harness.world.teamRows.set('member-1', invite());
      harness.world.listingFacts = {
        ...harness.world.listingFacts!,
        is_publicly_visible: false,
      };
      const refusal = await refusalOf(
        harness.service.accept(SUBPROFILE_ID, USER_ID, 'member-1'),
      );
      expect(refusal.statusCode).toBe(409);
      expect(refusal.code).toBe('listing_team_listing_not_live');
      expect(harness.manager.update).not.toHaveBeenCalled();
    });

    it("answers link not found to an accept of the persona's own request", async () => {
      const harness = buildHarness();
      harness.world.teamRows.set(
        'member-1',
        invite({ initiatedBy: ListingTeamInitiator.Persona }),
      );
      const refusal = await refusalOf(
        harness.service.accept(SUBPROFILE_ID, USER_ID, 'member-1'),
      );
      expect(refusal.code).toBe('listing_team_link_not_found');
      expect(harness.manager.update).not.toHaveBeenCalled();
    });

    it('answers link not found to a row of another persona', async () => {
      const harness = buildHarness();
      harness.world.teamRows.set(
        'member-1',
        invite({ subprofileId: 'persona-other' }),
      );
      const calls: (() => Promise<unknown>)[] = [
        () => harness.service.accept(SUBPROFILE_ID, USER_ID, 'member-1'),
        () => harness.service.decline(SUBPROFILE_ID, USER_ID, 'member-1'),
        () => harness.service.cancel(SUBPROFILE_ID, USER_ID, 'member-1'),
        () => harness.service.leave(SUBPROFILE_ID, USER_ID, 'member-1'),
      ];
      for (const call of calls) {
        const refusal = await refusalOf(call());
        expect(refusal.code).toBe('listing_team_link_not_found');
      }
      expect(harness.manager.update).not.toHaveBeenCalled();
    });

    it('refuses an accept of an answered invite with not pending', async () => {
      const harness = buildHarness();
      harness.world.teamRows.set(
        'member-1',
        invite({ status: ListingTeamMemberStatus.Declined }),
      );
      const refusal = await refusalOf(
        harness.service.accept(SUBPROFILE_ID, USER_ID, 'member-1'),
      );
      expect(refusal.code).toBe('listing_team_not_pending');
    });

    it('accepts at the end of the team and emits the acceptance', async () => {
      const harness = buildHarness();
      harness.world.teamRows.set('member-1', invite());
      harness.world.nextPosition = 4;
      const row = await harness.service.accept(
        SUBPROFILE_ID,
        USER_ID,
        'member-1',
      );
      expect(row.status).toBe('accepted');
      expect(row.answeredAt).not.toBeNull();
      expect(row.isListingLive).toBe(true);
      expect(JSON.stringify(row)).not.toContain('inviting-user-1');
      expect(harness.manager.update).toHaveBeenCalledWith(
        ListingTeamMember,
        { id: 'member-1' },
        {
          status: ListingTeamMemberStatus.Accepted,
          position: 4,
          answeredAt: expect.any(Date),
        },
      );
      expect(harness.emit).toHaveBeenCalledTimes(1);
      expect(harness.emit).toHaveBeenCalledWith(LISTING_TEAM_ACCEPTED, {
        memberId: 'member-1',
        actingUserId: USER_ID,
      });
      expect(harness.log.indexOf('commit')).toBeLessThan(
        harness.log.indexOf(`emit ${LISTING_TEAM_ACCEPTED}`),
      );
    });
  });

  describe('decline, cancel and leave', () => {
    it('declines an invite quietly with the answer time', async () => {
      const harness = buildHarness();
      harness.world.teamRows.set('member-1', makeMember());
      await harness.service.decline(SUBPROFILE_ID, USER_ID, 'member-1');
      expect(harness.manager.update).toHaveBeenCalledWith(
        ListingTeamMember,
        { id: 'member-1' },
        {
          status: ListingTeamMemberStatus.Declined,
          answeredAt: expect.any(Date),
        },
      );
      expect(harness.emit).not.toHaveBeenCalled();
    });

    it("answers link not found to a decline of the persona's own request and a cancel of an invite", async () => {
      const harness = buildHarness();
      harness.world.teamRows.set(
        'request-1',
        makeMember({
          id: 'request-1',
          initiatedBy: ListingTeamInitiator.Persona,
        }),
      );
      harness.world.teamRows.set('invite-1', makeMember({ id: 'invite-1' }));
      const declineRefusal = await refusalOf(
        harness.service.decline(SUBPROFILE_ID, USER_ID, 'request-1'),
      );
      const cancelRefusal = await refusalOf(
        harness.service.cancel(SUBPROFILE_ID, USER_ID, 'invite-1'),
      );
      expect(declineRefusal.code).toBe('listing_team_link_not_found');
      expect(cancelRefusal.code).toBe('listing_team_link_not_found');
      expect(harness.manager.update).not.toHaveBeenCalled();
    });

    it("cancels the persona's own pending request", async () => {
      const harness = buildHarness();
      harness.world.teamRows.set(
        'request-1',
        makeMember({
          id: 'request-1',
          initiatedBy: ListingTeamInitiator.Persona,
        }),
      );
      await harness.service.cancel(SUBPROFILE_ID, USER_ID, 'request-1');
      expect(harness.manager.update).toHaveBeenCalledWith(
        ListingTeamMember,
        { id: 'request-1' },
        { status: ListingTeamMemberStatus.Cancelled },
      );
      expect(harness.emit).not.toHaveBeenCalled();
    });

    it('leaves quietly and refuses to leave a pending row', async () => {
      const harness = buildHarness();
      harness.world.teamRows.set(
        'member-1',
        makeMember({
          status: ListingTeamMemberStatus.Accepted,
          position: 3,
          answeredAt: new Date('2026-10-18T10:00:00.000Z'),
        }),
      );
      await harness.service.leave(SUBPROFILE_ID, USER_ID, 'member-1');
      expect(harness.manager.update).toHaveBeenCalledWith(
        ListingTeamMember,
        { id: 'member-1' },
        { status: ListingTeamMemberStatus.Left, position: null },
      );
      expect(harness.emit).not.toHaveBeenCalled();

      const pending = buildHarness();
      pending.world.teamRows.set('member-1', makeMember());
      const refusal = await refusalOf(
        pending.service.leave(SUBPROFILE_ID, USER_ID, 'member-1'),
      );
      expect(refusal.statusCode).toBe(409);
      expect(refusal.code).toBe('listing_team_not_accepted');
      expect(pending.manager.update).not.toHaveBeenCalled();
    });

    it('locks the team row alone on decline', async () => {
      const harness = buildHarness();
      harness.world.teamRows.set('member-1', makeMember());
      await harness.service.decline(SUBPROFILE_ID, USER_ID, 'member-1');
      expect(harness.log).toEqual(['lock team row', 'update', 'commit']);
    });
  });

  describe('listForPersona', () => {
    it('always carries the listing and flags a hidden one', async () => {
      const harness = buildHarness();
      harness.world.listings = [
        makeListing(),
        makeListing({ id: 'listing-hidden', slug: 'gone', name: 'Gone' }),
      ];
      harness.world.liveListingIds = [LISTING_ID];
      harness.world.accepted = [
        makeMember({
          id: 'member-live',
          status: ListingTeamMemberStatus.Accepted,
          position: 1,
          answeredAt: new Date('2026-10-10T10:00:00.000Z'),
        }),
        makeMember({
          id: 'member-hidden',
          listingId: 'listing-hidden',
          status: ListingTeamMemberStatus.Accepted,
          position: 2,
          answeredAt: new Date('2026-10-11T10:00:00.000Z'),
        }),
      ];
      const list = await harness.service.listForPersona(SUBPROFILE_ID, USER_ID);
      expect(list.accepted.map((row) => row.id)).toEqual([
        'member-live',
        'member-hidden',
      ]);
      const hiddenRow = list.accepted[1];
      expect(hiddenRow?.listing.id).toBe('listing-hidden');
      expect(hiddenRow?.listing.slug).toBe('gone');
      expect(hiddenRow?.isListingLive).toBe(false);
      expect(list.accepted[0]?.isListingLive).toBe(true);
      const liveQuery = harness.manager.query.mock.calls.find(([sql]) =>
        sql.includes('= ANY($1::uuid[])'),
      );
      expect(liveQuery?.[0]).toContain(publiclyVisibleListingSql('listing'));
      expect(harness.manager.find).toHaveBeenCalledWith(
        Listing,
        expect.objectContaining({ select: LISTING_TEAM_LISTING_COLUMNS }),
      );
      expect(
        harness.manager.find.mock.calls.filter(
          ([entity]) => entity === Listing,
        ),
      ).toHaveLength(1);
      expect(JSON.stringify(list)).not.toContain('inviting-user-1');
      expect(JSON.stringify(list)).not.toContain('Ana Silva');
    });

    it('caps invites received at 100 and counts them all', async () => {
      const harness = buildHarness();
      harness.world.invitesReceived = Array.from(
        { length: 120 },
        (_unused, index) => makeMember({ id: `invite-${index}` }),
      );
      harness.world.invitesReceivedCount = 120;
      const list = await harness.service.listForPersona(SUBPROFILE_ID, USER_ID);
      expect(list.invitesReceived).toHaveLength(100);
      expect(list.awaitingYouCount).toBe(120);
      const inviteFind = harness.manager.find.mock.calls.find(
        ([entity, options]) =>
          entity === ListingTeamMember &&
          options.where?.initiatedBy === ListingTeamInitiator.Listing,
      );
      expect(inviteFind?.[1]).toMatchObject({
        order: { createdAt: 'DESC' },
        take: 100,
      });
    });

    it('answers empty lists with no listing query when nothing is linked', async () => {
      const harness = buildHarness();
      const list = await harness.service.listForPersona(SUBPROFILE_ID, USER_ID);
      expect(list).toEqual({
        awaitingYouCount: 0,
        invitesReceived: [],
        requestsSent: [],
        accepted: [],
      });
      expect(
        harness.manager.find.mock.calls.filter(
          ([entity]) => entity === Listing,
        ),
      ).toHaveLength(0);
    });
  });

  describe('searchCandidates', () => {
    it('finds publicly visible owned listings by name and leaves blocked owners out', async () => {
      const harness = buildHarness();
      harness.world.listings = [
        makeListing(),
        makeListing({ id: 'listing-2', slug: 'casa-u', name: 'Casa U' }),
      ];
      harness.world.candidateRows = [
        { id: LISTING_ID, team_status: ListingTeamMemberStatus.Accepted },
        { id: 'listing-2', team_status: null },
      ];
      const result = await harness.service.searchCandidates(
        SUBPROFILE_ID,
        USER_ID,
        '50%_off',
      );
      const searchCall = harness.manager.query.mock.calls.find(([sql]) =>
        sql.includes('ILIKE'),
      );
      const [sql, parameters] = searchCall as [string, unknown[]];
      expect(sql).toContain(`"listing"."name" ILIKE $2 ESCAPE '\\'`);
      expect(sql).toContain(`"member"."status" IN ('pending', 'accepted')`);
      expect(sql).toContain(publiclyVisibleListingSql('listing'));
      expect(sql).toContain('"listing"."owner_id" IS NOT NULL');
      expect(sql).toContain(
        notBlockedEitherWaySql('$3', '"listing"."owner_id"'),
      );
      expect(sql).toContain(
        notBlockedEitherWaySql('$4', '"listing"."owner_id"'),
      );
      expect(sql).toContain(
        'ORDER BY lower("listing"."name") ASC, "listing"."id" ASC',
      );
      expect(sql).toContain('LIMIT 20');
      expect(parameters).toEqual([
        SUBPROFILE_ID,
        '%50\\%\\_off%',
        USER_ID,
        USER_ID,
      ]);
      expect(harness.manager.find).toHaveBeenCalledWith(
        Listing,
        expect.objectContaining({ select: LISTING_TEAM_LISTING_COLUMNS }),
      );
      expect(result.items.map((item) => item.listing.id)).toEqual([
        LISTING_ID,
        'listing-2',
      ]);
      expect(result.items[0]?.teamStatus).toBe('accepted');
      expect(result.items[1]?.teamStatus).toBeNull();
      expect(JSON.stringify(result)).not.toContain(LISTING_OWNER_ID);
    });

    it("leaves out listings whose owner has a block with the persona's owner", async () => {
      const harness = buildHarness();
      harness.world.personaFacts = {
        ...harness.world.personaFacts!,
        user_id: PERSONA_OWNER_ID,
      };
      await harness.service.searchCandidates(SUBPROFILE_ID, USER_ID, 'casa');
      const searchCall = harness.manager.query.mock.calls.find(([sql]) =>
        sql.includes('ILIKE'),
      );
      const [sql, parameters] = searchCall as [string, unknown[]];
      expect(sql).toContain(
        notBlockedEitherWaySql('$4', '"listing"."owner_id"'),
      );
      expect(parameters[2]).toBe(USER_ID);
      expect(parameters[3]).toBe(PERSONA_OWNER_ID);
    });
  });

  describe('lock order', () => {
    it('locks the listing before the persona on request and before the team row on accept', async () => {
      const requesting = buildHarness();
      await requesting.service.request(SUBPROFILE_ID, USER_ID, requestBody);
      expect(requesting.log.slice(0, 2)).toEqual([
        'lock listing',
        'lock persona',
      ]);
      expect(requesting.log.indexOf('lock persona')).toBeLessThan(
        requesting.log.indexOf('read persona facts'),
      );
      expect(requesting.log.indexOf('lock persona')).toBeLessThan(
        requesting.log.indexOf('insert'),
      );

      const accepting = buildHarness();
      accepting.world.teamRows.set('member-1', makeMember());
      await accepting.service.accept(SUBPROFILE_ID, USER_ID, 'member-1');
      expect(accepting.log.slice(0, 5)).toEqual([
        'lock listing',
        'lock team row',
        'lock persona',
        'read persona facts',
        'update',
      ]);
      const unlockedRead = accepting.manager.findOne.mock.calls[0] as [
        unknown,
        FindOptions & { select?: Record<string, boolean> },
      ];
      expect(unlockedRead[1].lock).toBeUndefined();
      expect(unlockedRead[1].select).toEqual({
        id: true,
        listingId: true,
        subprofileId: true,
      });
    });

    it('counts the request caps only after the persona row is locked', async () => {
      const harness = buildHarness();
      await harness.service.request(SUBPROFILE_ID, USER_ID, requestBody);
      const personaLockOrder =
        harness.manager.query.mock.invocationCallOrder[
          harness.manager.query.mock.calls.findIndex(([sql]) =>
            sql.includes('FROM "subprofiles" WHERE "id" = $1 FOR UPDATE'),
          )
        ] ?? Number.POSITIVE_INFINITY;
      const firstCountOrder = Math.min(
        ...harness.manager.count.mock.invocationCallOrder,
      );
      expect(personaLockOrder).toBeLessThan(firstCountOrder);
    });
  });
});
