import { HttpException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager } from 'typeorm';
import { MediaCropService } from '../media-crops/media-crops.service';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import {
  SubprofileKind,
  SubprofileLinkVisibility,
} from '../subprofiles/entities/subprofile.entity';
import {
  ListingTeamInitiator,
  ListingTeamMember,
  ListingTeamMemberStatus,
} from './entities/listing-team-member.entity';
import type { Listing } from './entities/listing.entity';
import {
  eligibleMemberSql,
  notBlockedEitherWaySql,
  notHiddenFromViewerSql,
} from './listing-team-visibility';
import {
  LISTING_TEAM_ACCEPTED,
  LISTING_TEAM_INVITED,
  LISTING_TEAM_MEMBER_INVITED,
} from './listing-team.events';
import { ListingTeamService } from './listing-team.service';
import { ListingsService } from './listings.service';

const LISTING_ID = 'listing-1';
const LISTING_REF = 'QPL-2026-0007';
const USER_ID = 'manager-1';
const PERSONA_ID = 'persona-1';
const PERSONA_OWNER_ID = 'persona-owner-1';
/** The listing's owner when the caller is a co-manager. */
const LISTING_OWNER_ID = 'listing-owner-1';
const INSERTED_MEMBER_ID = 'member-new';
/** The member a manager invites from the profile slug `MEMBER_SLUG`. */
const MEMBER_USER_ID = 'member-user-1';
const MEMBER_SLUG = 'ana-silva';

interface PersonaFactsRow {
  id: string;
  user_id: string;
  is_eligible: boolean;
}

interface PersonaRow {
  id: string;
  handle: string | null;
  display_name: string;
  kind: SubprofileKind;
  avatar_url: string | null;
  link_visibility: SubprofileLinkVisibility;
  owner_first_name: string | null;
  owner_last_name: string | null;
}

interface MemberFactsRow {
  user_id: string;
  is_eligible: boolean;
}

interface MemberProfileRow {
  user_id: string;
  slug: string;
  first_name: string;
  last_name: string;
  avatar_url: string | null;
  photo_visible: boolean;
}

interface CandidateRow extends PersonaRow {
  team_status: ListingTeamMemberStatus | null;
}

/** What the database answers for one test. */
interface Scenario {
  isListingVisible: boolean;
  listingOwnerId: string | null;
  isPersonaRowPresent: boolean;
  personaFacts: PersonaFactsRow | null;
  isBlocked: boolean;
  /** A block either way that any block query naming both members finds. */
  blockedPair: [string, string] | null;
  isPersonaMember: boolean;
  acceptedOnListing: number;
  acceptedOfPersona: number;
  pendingOnListing: number;
  nextPosition: number;
  teamRow: ListingTeamMember | null;
  liveRow: ListingTeamMember | null;
  visiblePersonaRows: PersonaRow[];
  candidateRows: CandidateRow[];
  acceptedIds: string[];
  members: ListingTeamMember[];
  /** The user id the slug `MEMBER_SLUG` resolves to, null for an unknown slug. */
  slugUserId: string | null;
  isConnected: boolean;
  memberFacts: MemberFactsRow | null;
  acceptedOfMember: number;
  cooldownRetryAt: Date | null;
  visibleMemberRows: MemberProfileRow[];
}

interface ManagerMock {
  getRepository: jest.Mock;
  query: jest.Mock;
  findOne: jest.Mock;
  findOneOrFail: jest.Mock;
  find: jest.Mock;
  count: jest.Mock;
  update: jest.Mock;
}

const teamRow = (overrides: Partial<ListingTeamMember>): ListingTeamMember => ({
  id: 'member-1',
  listingId: LISTING_ID,
  subprofileId: PERSONA_ID,
  userId: null,
  roleLabel: null,
  status: ListingTeamMemberStatus.Pending,
  initiatedBy: ListingTeamInitiator.Persona,
  requestedByUserId: PERSONA_OWNER_ID,
  answeredAt: null,
  position: null,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  ...overrides,
});

const personaRow = (overrides: Partial<PersonaRow> = {}): PersonaRow => ({
  id: PERSONA_ID,
  handle: 'inkbyrui',
  display_name: 'Rui Ink',
  kind: SubprofileKind.TattooArtist,
  avatar_url: null,
  link_visibility: SubprofileLinkVisibility.Unlinked,
  owner_first_name: null,
  owner_last_name: null,
  ...overrides,
});

const memberProfileRow = (
  overrides: Partial<MemberProfileRow> = {},
): MemberProfileRow => ({
  user_id: MEMBER_USER_ID,
  slug: MEMBER_SLUG,
  first_name: 'Ana',
  last_name: 'Silva',
  avatar_url: null,
  photo_visible: true,
  ...overrides,
});

const memberTeamRow = (
  overrides: Partial<ListingTeamMember>,
): ListingTeamMember =>
  teamRow({
    subprofileId: null,
    userId: MEMBER_USER_ID,
    initiatedBy: ListingTeamInitiator.Listing,
    requestedByUserId: USER_ID,
    ...overrides,
  });

const baseScenario = (): Scenario => ({
  isListingVisible: true,
  listingOwnerId: USER_ID,
  isPersonaRowPresent: true,
  personaFacts: {
    id: PERSONA_ID,
    user_id: PERSONA_OWNER_ID,
    is_eligible: true,
  },
  isBlocked: false,
  blockedPair: null,
  isPersonaMember: false,
  acceptedOnListing: 0,
  acceptedOfPersona: 0,
  pendingOnListing: 0,
  nextPosition: 1,
  teamRow: null,
  liveRow: null,
  visiblePersonaRows: [personaRow()],
  candidateRows: [],
  acceptedIds: [],
  members: [],
  slugUserId: MEMBER_USER_ID,
  isConnected: true,
  memberFacts: { user_id: MEMBER_USER_ID, is_eligible: true },
  acceptedOfMember: 0,
  cooldownRetryAt: null,
  visibleMemberRows: [memberProfileRow()],
});

/** Runs the call and answers the response body of the HttpException it threw. */
const refusalOf = async (call: Promise<unknown>): Promise<object> => {
  try {
    await call;
  } catch (error) {
    if (error instanceof HttpException) {
      return error.getResponse() as object;
    }
    throw error;
  }
  throw new Error('Expected the call to refuse');
};

describe('ListingTeamService', () => {
  let scenario: Scenario;
  let journal: string[];
  let insertedParameters: unknown[] | null;
  let isInsertedRowMember: boolean;
  let manager: ManagerMock;
  let eventEmitter: { emit: jest.Mock };
  let loadOwnedOrCoManagedOr404: jest.Mock;
  let service: ListingTeamService;

  const answerQuery = (sql: string, parameters: unknown[] = []): unknown[] => {
    if (sql.includes('ILIKE')) {
      return scenario.candidateRows;
    }
    if (sql.includes('FROM "profiles" "member_profile"')) {
      const ids = parameters[0] as string[];
      return scenario.visibleMemberRows.filter((row) =>
        ids.includes(row.user_id),
      );
    }
    if (sql.includes('FROM "users" "member_user"')) {
      return scenario.memberFacts ? [scenario.memberFacts] : [];
    }
    if (sql.includes('AS "is_connected"')) {
      journal.push('read connection');
      return [{ is_connected: scenario.isConnected }];
    }
    if (sql.includes('pg_advisory_xact_lock')) {
      journal.push('lock member cap');
      return [];
    }
    if (sql.includes('ANY($1::uuid[])')) {
      const ids = parameters[0] as string[];
      return scenario.visiblePersonaRows.filter((row) => ids.includes(row.id));
    }
    if (sql.includes('FOR UPDATE') && sql.includes('FROM "listings"')) {
      journal.push('lock listings');
      return [];
    }
    if (sql.includes('FOR UPDATE') && sql.includes('FROM "subprofiles"')) {
      journal.push('lock subprofiles');
      return scenario.isPersonaRowPresent ? [{ id: PERSONA_ID }] : [];
    }
    if (sql.includes('AS "is_publicly_visible"')) {
      return [
        {
          id: LISTING_ID,
          ref: LISTING_REF,
          slug: 'ink-house',
          name: 'Ink House',
          owner_id: scenario.listingOwnerId,
          is_publicly_visible: scenario.isListingVisible,
        },
      ];
    }
    if (sql.includes('AS "is_eligible"')) {
      journal.push('read persona facts');
      return scenario.personaFacts ? [scenario.personaFacts] : [];
    }
    if (sql.includes('AS "is_blocked"')) {
      const blockedPair = scenario.blockedPair;
      const isPairBlocked =
        blockedPair !== null &&
        blockedPair.every((blockedUserId) =>
          parameters.includes(blockedUserId),
        );
      return [{ is_blocked: scenario.isBlocked || isPairBlocked }];
    }
    if (sql.includes('make_interval')) {
      return scenario.cooldownRetryAt
        ? [{ retry_at: scenario.cooldownRetryAt }]
        : [];
    }
    if (sql.includes('"next_position"')) {
      return [{ next_position: scenario.nextPosition }];
    }
    if (sql.includes('INSERT INTO "listing_team_members"')) {
      insertedParameters = parameters;
      isInsertedRowMember = sql.includes('"listing_id", "user_id"');
      return [{ id: INSERTED_MEMBER_ID }];
    }
    if (sql.includes('unnest(')) {
      return [];
    }
    if (sql.includes('SELECT "member"."id"')) {
      return scenario.acceptedIds.map((id) => ({ id }));
    }
    throw new Error(`Unexpected SQL in the test: ${sql}`);
  };

  const insertedRow = (): ListingTeamMember => {
    const values = insertedParameters ?? [];
    return teamRow({
      id: INSERTED_MEMBER_ID,
      listingId: values[0] as string,
      subprofileId: isInsertedRowMember ? null : (values[1] as string),
      userId: isInsertedRowMember ? (values[1] as string) : null,
      initiatedBy: values[2] as ListingTeamInitiator,
      requestedByUserId: values[3] as string,
      roleLabel: values[4] as string | null,
      status: values[5] as ListingTeamMemberStatus,
      position: values[6] as number | null,
      answeredAt: values[7] as Date | null,
    });
  };

  const answerCount = (
    entity: unknown,
    options: { where: Partial<ListingTeamMember> },
  ): number => {
    if (entity === SubprofileMember) {
      return scenario.isPersonaMember ? 1 : 0;
    }
    const where = options.where;
    if (where.status === ListingTeamMemberStatus.Accepted && where.userId) {
      return scenario.acceptedOfMember;
    }
    if (where.status === ListingTeamMemberStatus.Accepted) {
      return where.listingId
        ? scenario.acceptedOnListing
        : scenario.acceptedOfPersona;
    }
    if (where.status === ListingTeamMemberStatus.Pending && where.listingId) {
      return scenario.pendingOnListing;
    }
    return 0;
  };

  const queriesContaining = (fragment: string): unknown[][] =>
    manager.query.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes(fragment),
    );

  beforeEach(() => {
    scenario = baseScenario();
    journal = [];
    insertedParameters = null;
    isInsertedRowMember = false;
    manager = {
      getRepository: jest.fn(),
      query: jest.fn((sql: string, parameters?: unknown[]) =>
        Promise.resolve(answerQuery(sql, parameters)),
      ),
      findOne: jest.fn((_entity: unknown, options: { lock?: unknown }) => {
        if (options.lock) {
          journal.push('lock listing_team_members');
          return Promise.resolve(scenario.teamRow);
        }
        return Promise.resolve(scenario.liveRow);
      }),
      findOneOrFail: jest.fn(() => Promise.resolve(insertedRow())),
      find: jest.fn(
        (_entity: unknown, options: { where: Partial<ListingTeamMember> }) =>
          Promise.resolve(
            scenario.members.filter(
              (member) =>
                options.where.status !== ListingTeamMemberStatus.Accepted ||
                member.status === ListingTeamMemberStatus.Accepted,
            ),
          ),
      ),
      count: jest.fn(
        (entity: unknown, options: { where: Partial<ListingTeamMember> }) =>
          Promise.resolve(answerCount(entity, options)),
      ),
      update: jest.fn(() => Promise.resolve({ affected: 1 })),
    };
    interface MemberQueryBuilder {
      innerJoin: jest.Mock<MemberQueryBuilder, []>;
      where: jest.Mock<MemberQueryBuilder, []>;
      getMany: jest.Mock<Promise<{ slug: string; userId: string }[]>, []>;
    }
    const memberQueryBuilder: MemberQueryBuilder = {
      innerJoin: jest.fn(() => memberQueryBuilder),
      where: jest.fn(() => memberQueryBuilder),
      getMany: jest.fn(() =>
        Promise.resolve(
          scenario.slugUserId
            ? [{ slug: MEMBER_SLUG, userId: scenario.slugUserId }]
            : [],
        ),
      ),
    };
    manager.getRepository = jest.fn(() => ({
      createQueryBuilder: jest.fn(() => memberQueryBuilder),
    }));
    const dataSource = {
      manager,
      getRepository: jest.fn(() => {
        throw new Error('Open no second pool connection inside a transaction');
      }),
      transaction: jest.fn(
        async (
          work: (transactionManager: EntityManager) => Promise<unknown>,
        ) => {
          const result = await work(manager as unknown as EntityManager);
          journal.push('commit');
          return result;
        },
      ),
    };
    eventEmitter = {
      emit: jest.fn(() => {
        journal.push('emit');
        return true;
      }),
    };
    loadOwnedOrCoManagedOr404 = jest.fn(() =>
      Promise.resolve({
        listing: {
          id: LISTING_ID,
          ownerId: scenario.listingOwnerId,
        } as Listing,
        isOwner: true,
      }),
    );
    service = new ListingTeamService(
      dataSource as unknown as DataSource,
      { loadOwnedOrCoManagedOr404 } as unknown as ListingsService,
      {
        getMany: jest.fn(() => Promise.resolve(new Map())),
      } as unknown as MediaCropService,
      eventEmitter as unknown as EventEmitter2,
    );
  });

  describe('invite', () => {
    it('answers persona not found to an invite of a persona whose owner blocks the caller', async () => {
      scenario.isBlocked = true;

      await expect(
        refusalOf(
          service.invite(LISTING_REF, USER_ID, { subprofileId: PERSONA_ID }),
        ),
      ).resolves.toMatchObject({
        statusCode: 404,
        code: 'listing_team_persona_not_found',
      });
      expect(queriesContaining('INSERT INTO')).toHaveLength(0);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('refuses an invite when the listing owner and the persona owner have a block', async () => {
      scenario.listingOwnerId = LISTING_OWNER_ID;
      scenario.blockedPair = [LISTING_OWNER_ID, PERSONA_OWNER_ID];

      await expect(
        refusalOf(
          service.invite(LISTING_REF, USER_ID, { subprofileId: PERSONA_ID }),
        ),
      ).resolves.toMatchObject({
        statusCode: 404,
        code: 'listing_team_persona_not_found',
      });
      expect(queriesContaining('AS "is_blocked"')).toHaveLength(2);
      expect(queriesContaining('INSERT INTO')).toHaveLength(0);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('invites from a co-manager when no block touches the listing owner', async () => {
      scenario.listingOwnerId = LISTING_OWNER_ID;

      await expect(
        service.invite(LISTING_REF, USER_ID, { subprofileId: PERSONA_ID }),
      ).resolves.toMatchObject({ status: 'pending' });
      const blockParameters = queriesContaining('AS "is_blocked"').map(
        (call) => call[1],
      );
      expect(blockParameters).toEqual([
        [USER_ID, PERSONA_OWNER_ID],
        [PERSONA_OWNER_ID, LISTING_OWNER_ID],
      ]);
    });

    it('answers persona not found when the persona row is gone at the lock', async () => {
      scenario.isPersonaRowPresent = false;

      await expect(
        refusalOf(
          service.invite(LISTING_REF, USER_ID, { subprofileId: PERSONA_ID }),
        ),
      ).resolves.toMatchObject({
        statusCode: 404,
        code: 'listing_team_persona_not_found',
      });
      expect(journal).not.toContain('read persona facts');
      expect(queriesContaining('INSERT INTO')).toHaveLength(0);
    });

    it('locks the listing, then the persona, before reading persona facts on invite', async () => {
      await service.invite(LISTING_REF, USER_ID, { subprofileId: PERSONA_ID });

      expect(
        journal.filter(
          (entry) =>
            entry.startsWith('lock ') || entry === 'read persona facts',
        ),
      ).toEqual(['lock listings', 'lock subprofiles', 'read persona facts']);
    });

    it('refuses an invite of an ineligible persona with 422', async () => {
      scenario.personaFacts = {
        id: PERSONA_ID,
        user_id: PERSONA_OWNER_ID,
        is_eligible: false,
      };

      await expect(
        refusalOf(
          service.invite(LISTING_REF, USER_ID, { subprofileId: PERSONA_ID }),
        ),
      ).resolves.toMatchObject({
        statusCode: 422,
        code: 'listing_team_persona_ineligible',
      });
      expect(queriesContaining('INSERT INTO')).toHaveLength(0);
    });

    it('refuses an invite from a hidden listing with listing not live', async () => {
      scenario.isListingVisible = false;

      await expect(
        refusalOf(
          service.invite(LISTING_REF, USER_ID, { subprofileId: PERSONA_ID }),
        ),
      ).resolves.toMatchObject({
        statusCode: 409,
        code: 'listing_team_listing_not_live',
      });
      expect(queriesContaining('INSERT INTO')).toHaveLength(0);
    });

    it('invites a persona as pending and emits the invite after commit', async () => {
      const row = await service.invite(LISTING_REF, USER_ID, {
        subprofileId: PERSONA_ID,
        roleLabel: 'Resident artist',
      });

      expect(row).toMatchObject({
        id: INSERTED_MEMBER_ID,
        status: 'pending',
        initiatedBy: 'listing',
        roleLabel: 'Resident artist',
        position: null,
        answeredAt: null,
      });
      expect(row.persona?.id).toBe(PERSONA_ID);
      expect(row).not.toHaveProperty('requestedByUserId');
      expect(insertedParameters?.[5]).toBe(ListingTeamMemberStatus.Pending);
      expect(insertedParameters?.[6]).toBeNull();
      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(LISTING_TEAM_INVITED, {
        memberId: INSERTED_MEMBER_ID,
        actingUserId: USER_ID,
      });
      expect(journal.indexOf('commit')).toBeLessThan(journal.indexOf('emit'));
    });

    it('links a persona the caller co-owns at once, at the end, with no notification', async () => {
      scenario.isPersonaMember = true;
      scenario.nextPosition = 7;

      const row = await service.invite(LISTING_REF, USER_ID, {
        subprofileId: PERSONA_ID,
      });

      expect(row.status).toBe('accepted');
      expect(row.position).toBe(7);
      expect(row.answeredAt).not.toBeNull();
      expect(insertedParameters?.[7]).toBeInstanceOf(Date);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('lets the 40th member in and refuses the 41st invite', async () => {
      scenario.acceptedOnListing = 39;
      await expect(
        service.invite(LISTING_REF, USER_ID, { subprofileId: PERSONA_ID }),
      ).resolves.toMatchObject({ status: 'pending' });

      scenario.acceptedOnListing = 40;
      insertedParameters = null;
      await expect(
        refusalOf(
          service.invite(LISTING_REF, USER_ID, { subprofileId: PERSONA_ID }),
        ),
      ).resolves.toMatchObject({ statusCode: 409, code: 'listing_team_full' });
      expect(insertedParameters).toBeNull();
    });

    it('refuses the 41st pending invite', async () => {
      scenario.pendingOnListing = 40;

      await expect(
        refusalOf(
          service.invite(LISTING_REF, USER_ID, { subprofileId: PERSONA_ID }),
        ),
      ).resolves.toMatchObject({
        statusCode: 409,
        code: 'listing_team_pending_full',
      });
      expect(queriesContaining('INSERT INTO')).toHaveLength(0);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('inviteMember', () => {
    const inviteMember = (roleLabel?: string | null) =>
      service.inviteMember(LISTING_REF, USER_ID, {
        memberSlug: MEMBER_SLUG,
        roleLabel,
      });

    it('invites a connection as pending, emits after commit and answers a member row', async () => {
      const row = await inviteMember('Chef');

      expect(row).toMatchObject({
        kind: 'member',
        id: INSERTED_MEMBER_ID,
        status: 'pending',
        initiatedBy: 'listing',
        roleLabel: 'Chef',
        position: null,
        answeredAt: null,
        member: { slug: MEMBER_SLUG, name: 'Ana Silva', avatarUrl: null },
      });
      expect(row).not.toHaveProperty('persona');
      expect(row).not.toHaveProperty('userId');
      expect(row).not.toHaveProperty('requestedByUserId');
      expect(insertedParameters).toEqual([
        LISTING_ID,
        MEMBER_USER_ID,
        'listing',
        USER_ID,
        'Chef',
        'pending',
        null,
        null,
      ]);
      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        LISTING_TEAM_MEMBER_INVITED,
        { memberId: INSERTED_MEMBER_ID, actingUserId: USER_ID },
      );
      expect(journal.indexOf('commit')).toBeLessThan(journal.indexOf('emit'));
    });

    it('locks the listing, then the member advisory lock, before any cap count', async () => {
      await inviteMember();

      expect(journal.filter((entry) => entry.startsWith('lock '))).toEqual([
        'lock listings',
        'lock member cap',
      ]);
      expect(journal.indexOf('lock member cap')).toBeLessThan(
        journal.indexOf('commit'),
      );
    });

    it('refuses an invite from a hidden listing with listing not live', async () => {
      scenario.isListingVisible = false;

      await expect(refusalOf(inviteMember())).resolves.toMatchObject({
        statusCode: 409,
        code: 'listing_team_listing_not_live',
      });
      expect(queriesContaining('INSERT INTO')).toHaveLength(0);
    });

    it('answers member not found to an unknown slug', async () => {
      scenario.slugUserId = null;

      await expect(refusalOf(inviteMember())).resolves.toMatchObject({
        statusCode: 404,
        code: 'listing_team_member_not_found',
      });
      expect(queriesContaining('INSERT INTO')).toHaveLength(0);
    });

    it('answers member not found to a self invite before reading the connection', async () => {
      scenario.slugUserId = USER_ID;

      await expect(refusalOf(inviteMember())).resolves.toMatchObject({
        statusCode: 404,
        code: 'listing_team_member_not_found',
      });
      expect(journal).not.toContain('read connection');
      expect(queriesContaining('INSERT INTO')).toHaveLength(0);
    });

    it('answers member not found to a member who is not an accepted connection', async () => {
      scenario.isConnected = false;

      await expect(refusalOf(inviteMember())).resolves.toMatchObject({
        statusCode: 404,
        code: 'listing_team_member_not_found',
      });
      expect(queriesContaining('AS "is_connected"')[0]?.[1]).toEqual([
        USER_ID,
        MEMBER_USER_ID,
      ]);
      expect(queriesContaining('INSERT INTO')).toHaveLength(0);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('answers the same member not found to a block, never naming it', async () => {
      scenario.blockedPair = [USER_ID, MEMBER_USER_ID];

      const refusal = await refusalOf(inviteMember());

      expect(refusal).toMatchObject({
        statusCode: 404,
        code: 'listing_team_member_not_found',
      });
      expect(JSON.stringify(refusal).toLowerCase()).not.toContain('block');
      expect(queriesContaining('INSERT INTO')).toHaveLength(0);
    });

    it('answers the same member not found when the member and the listing owner have a block', async () => {
      scenario.listingOwnerId = LISTING_OWNER_ID;
      scenario.blockedPair = [LISTING_OWNER_ID, MEMBER_USER_ID];

      const refusal = await refusalOf(inviteMember());

      expect(refusal).toMatchObject({
        statusCode: 404,
        code: 'listing_team_member_not_found',
      });
      expect(JSON.stringify(refusal).toLowerCase()).not.toContain('block');
      expect(queriesContaining('AS "is_blocked"')).toHaveLength(2);
      expect(queriesContaining('INSERT INTO')).toHaveLength(0);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('checks no second block when the acting manager is the listing owner', async () => {
      await inviteMember();

      expect(queriesContaining('AS "is_blocked"')).toHaveLength(1);
    });

    it('handles a listing with no owner like the persona path, with one block check', async () => {
      scenario.listingOwnerId = null;

      await expect(inviteMember()).resolves.toMatchObject({
        status: 'pending',
      });
      expect(queriesContaining('AS "is_blocked"')).toHaveLength(1);
    });

    it('resolves the slug through the transaction manager, never a second pool connection', async () => {
      await inviteMember();

      expect(manager.getRepository).toHaveBeenCalledTimes(1);
    });

    it('answers already pending for a re-invite at 40 pending, before the pending room check', async () => {
      scenario.pendingOnListing = 40;
      scenario.liveRow = memberTeamRow({
        status: ListingTeamMemberStatus.Pending,
      });

      await expect(refusalOf(inviteMember())).resolves.toMatchObject({
        statusCode: 409,
        code: 'listing_team_already_pending',
        initiatedBy: 'listing',
      });
      expect(queriesContaining('INSERT INTO')).toHaveLength(0);
    });

    it('refuses an ineligible member with 422 after the connection checks pass', async () => {
      scenario.memberFacts = { user_id: MEMBER_USER_ID, is_eligible: false };

      await expect(refusalOf(inviteMember())).resolves.toMatchObject({
        statusCode: 422,
        code: 'listing_team_member_ineligible',
      });
      expect(queriesContaining('INSERT INTO')).toHaveLength(0);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('answers member not found when the member has no profile row at the lock', async () => {
      scenario.memberFacts = null;

      await expect(refusalOf(inviteMember())).resolves.toMatchObject({
        statusCode: 404,
        code: 'listing_team_member_not_found',
      });
    });

    it('counts the 40 pending across both kinds and refuses the 41st', async () => {
      scenario.pendingOnListing = 39;
      await expect(inviteMember()).resolves.toMatchObject({
        status: 'pending',
      });

      scenario.pendingOnListing = 40;
      insertedParameters = null;
      await expect(refusalOf(inviteMember())).resolves.toMatchObject({
        statusCode: 409,
        code: 'listing_team_pending_full',
      });
      expect(insertedParameters).toBeNull();
    });

    it('refuses the 41st accepted row on the listing', async () => {
      scenario.acceptedOnListing = 40;

      await expect(refusalOf(inviteMember())).resolves.toMatchObject({
        statusCode: 409,
        code: 'listing_team_full',
      });
      expect(queriesContaining('INSERT INTO')).toHaveLength(0);
    });

    it('refuses a member who is already on 10 teams', async () => {
      scenario.acceptedOfMember = 10;

      await expect(refusalOf(inviteMember())).resolves.toMatchObject({
        statusCode: 409,
        code: 'listing_team_member_full',
      });
      expect(queriesContaining('INSERT INTO')).toHaveLength(0);
    });

    it('refuses a member who is already on the team or already invited', async () => {
      scenario.liveRow = memberTeamRow({
        status: ListingTeamMemberStatus.Accepted,
        position: 1,
      });
      await expect(refusalOf(inviteMember())).resolves.toMatchObject({
        statusCode: 409,
        code: 'listing_team_already_accepted',
      });

      scenario.liveRow = memberTeamRow({
        status: ListingTeamMemberStatus.Pending,
      });
      await expect(refusalOf(inviteMember())).resolves.toMatchObject({
        statusCode: 409,
        code: 'listing_team_already_pending',
        initiatedBy: 'listing',
      });
      expect(queriesContaining('INSERT INTO')).toHaveLength(0);
    });

    it('refuses a re-invite inside the 14 day cooldown with the retry date', async () => {
      scenario.cooldownRetryAt = new Date('2026-11-05T10:00:00.000Z');

      await expect(refusalOf(inviteMember())).resolves.toMatchObject({
        statusCode: 409,
        code: 'listing_team_cooldown',
        retryAt: '2026-11-05T10:00:00.000Z',
      });
      expect(queriesContaining('INSERT INTO')).toHaveLength(0);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('member rows on the other routes', () => {
    it('answers link not found to an approve and a decline of a member row', async () => {
      scenario.teamRow = memberTeamRow({});

      await expect(
        refusalOf(service.approve(LISTING_REF, USER_ID, 'member-1', {})),
      ).resolves.toMatchObject({
        statusCode: 404,
        code: 'listing_team_link_not_found',
      });
      await expect(
        refusalOf(service.decline(LISTING_REF, USER_ID, 'member-1')),
      ).resolves.toMatchObject({
        statusCode: 404,
        code: 'listing_team_link_not_found',
      });
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('cancels a pending member invite', async () => {
      scenario.teamRow = memberTeamRow({});

      await service.cancel(LISTING_REF, USER_ID, 'member-1');

      expect(manager.update).toHaveBeenCalledWith(
        ListingTeamMember,
        { id: 'member-1' },
        { status: ListingTeamMemberStatus.Cancelled },
      );
    });

    it('removes an accepted member row', async () => {
      scenario.teamRow = memberTeamRow({
        status: ListingTeamMemberStatus.Accepted,
        position: 1,
      });

      await service.remove(LISTING_REF, USER_ID, 'member-1');

      expect(manager.update).toHaveBeenCalledWith(
        ListingTeamMember,
        { id: 'member-1' },
        { status: ListingTeamMemberStatus.Removed, position: null },
      );
    });
  });

  describe('approve', () => {
    it('answers link not found to an approve across a block', async () => {
      scenario.teamRow = teamRow({});
      scenario.isBlocked = true;

      await expect(
        refusalOf(service.approve(LISTING_REF, USER_ID, 'member-1', {})),
      ).resolves.toMatchObject({
        statusCode: 404,
        code: 'listing_team_link_not_found',
      });
      expect(manager.update).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('refuses an approve when the listing owner and the persona owner have a block', async () => {
      scenario.teamRow = teamRow({});
      scenario.listingOwnerId = LISTING_OWNER_ID;
      scenario.blockedPair = [PERSONA_OWNER_ID, LISTING_OWNER_ID];

      await expect(
        refusalOf(service.approve(LISTING_REF, USER_ID, 'member-1', {})),
      ).resolves.toMatchObject({
        statusCode: 404,
        code: 'listing_team_link_not_found',
      });
      expect(manager.update).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('answers link not found when the persona row is gone at the lock', async () => {
      scenario.teamRow = teamRow({});
      scenario.isPersonaRowPresent = false;

      await expect(
        refusalOf(service.approve(LISTING_REF, USER_ID, 'member-1', {})),
      ).resolves.toMatchObject({
        statusCode: 404,
        code: 'listing_team_link_not_found',
      });
      expect(journal).not.toContain('read persona facts');
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('answers link not found to an approve of an invite', async () => {
      scenario.teamRow = teamRow({ initiatedBy: ListingTeamInitiator.Listing });

      await expect(
        refusalOf(service.approve(LISTING_REF, USER_ID, 'member-1', {})),
      ).resolves.toMatchObject({
        statusCode: 404,
        code: 'listing_team_link_not_found',
      });
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('refuses an approve of an answered request', async () => {
      scenario.teamRow = teamRow({
        status: ListingTeamMemberStatus.Declined,
        answeredAt: new Date('2026-10-02T00:00:00.000Z'),
      });

      await expect(
        refusalOf(service.approve(LISTING_REF, USER_ID, 'member-1', {})),
      ).resolves.toMatchObject({
        statusCode: 409,
        code: 'listing_team_not_pending',
      });
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('approves at the end and keeps the stored label when the body has none', async () => {
      scenario.teamRow = teamRow({ roleLabel: 'Guest artist' });
      scenario.nextPosition = 4;

      const kept = await service.approve(LISTING_REF, USER_ID, 'member-1', {});

      expect(kept).toMatchObject({
        status: 'accepted',
        position: 4,
        roleLabel: 'Guest artist',
      });
      expect(kept.answeredAt).not.toBeNull();
      expect(manager.update).toHaveBeenCalledWith(
        ListingTeamMember,
        { id: 'member-1' },
        expect.objectContaining({
          status: ListingTeamMemberStatus.Accepted,
          position: 4,
          roleLabel: 'Guest artist',
        }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(LISTING_TEAM_ACCEPTED, {
        memberId: 'member-1',
        actingUserId: USER_ID,
      });
      expect(journal.indexOf('commit')).toBeLessThan(journal.indexOf('emit'));

      scenario.teamRow = teamRow({ roleLabel: 'Guest artist' });
      const cleared = await service.approve(LISTING_REF, USER_ID, 'member-1', {
        roleLabel: null,
      });
      expect(cleared.roleLabel).toBeNull();
    });

    it('locks the listing before the team row before the persona on approve', async () => {
      scenario.teamRow = teamRow({});

      await service.approve(LISTING_REF, USER_ID, 'member-1', {});

      expect(
        journal.filter(
          (entry) =>
            entry.startsWith('lock ') || entry === 'read persona facts',
        ),
      ).toEqual([
        'lock listings',
        'lock listing_team_members',
        'lock subprofiles',
        'read persona facts',
      ]);
    });
  });

  it("declines quietly and starts the side's cooldown", async () => {
    scenario.teamRow = teamRow({});

    await service.decline(LISTING_REF, USER_ID, 'member-1');

    expect(manager.update).toHaveBeenCalledWith(
      ListingTeamMember,
      { id: 'member-1' },
      {
        status: ListingTeamMemberStatus.Declined,
        answeredAt: expect.any(Date) as unknown,
      },
    );
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('answers link not found to a decline of its own invite and a cancel of a request', async () => {
    scenario.teamRow = teamRow({ initiatedBy: ListingTeamInitiator.Listing });
    await expect(
      refusalOf(service.decline(LISTING_REF, USER_ID, 'member-1')),
    ).resolves.toMatchObject({
      statusCode: 404,
      code: 'listing_team_link_not_found',
    });

    scenario.teamRow = teamRow({ initiatedBy: ListingTeamInitiator.Persona });
    await expect(
      refusalOf(service.cancel(LISTING_REF, USER_ID, 'member-1')),
    ).resolves.toMatchObject({
      statusCode: 404,
      code: 'listing_team_link_not_found',
    });
    expect(manager.update).not.toHaveBeenCalled();
  });

  describe('updateRoleLabel', () => {
    it('relabels an accepted member', async () => {
      scenario.teamRow = teamRow({
        status: ListingTeamMemberStatus.Accepted,
        position: 2,
        answeredAt: new Date('2026-10-03T00:00:00.000Z'),
        roleLabel: 'Barber',
      });

      const row = await service.updateRoleLabel(
        LISTING_REF,
        USER_ID,
        'member-1',
        { roleLabel: 'Head barber' },
      );

      expect(row).toMatchObject({
        id: 'member-1',
        status: 'accepted',
        position: 2,
        roleLabel: 'Head barber',
      });
      expect(manager.update).toHaveBeenCalledWith(
        ListingTeamMember,
        { id: 'member-1' },
        { roleLabel: 'Head barber' },
      );
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('refuses to relabel an ended row with not pending', async () => {
      scenario.teamRow = teamRow({ status: ListingTeamMemberStatus.Removed });

      await expect(
        refusalOf(
          service.updateRoleLabel(LISTING_REF, USER_ID, 'member-1', {
            roleLabel: 'Barber',
          }),
        ),
      ).resolves.toMatchObject({
        statusCode: 409,
        code: 'listing_team_not_pending',
      });
      expect(manager.update).not.toHaveBeenCalled();
    });
  });

  it('refuses to remove a pending row with not accepted', async () => {
    scenario.teamRow = teamRow({});

    await expect(
      refusalOf(service.remove(LISTING_REF, USER_ID, 'member-1')),
    ).resolves.toMatchObject({
      statusCode: 409,
      code: 'listing_team_not_accepted',
    });
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('answers link not found to a row of another listing', async () => {
    const otherListingRow = (): ListingTeamMember =>
      teamRow({ listingId: 'listing-other' });
    const routes: Array<() => Promise<unknown>> = [
      () => service.approve(LISTING_REF, USER_ID, 'member-1', {}),
      () => service.decline(LISTING_REF, USER_ID, 'member-1'),
      () => service.cancel(LISTING_REF, USER_ID, 'member-1'),
      () =>
        service.updateRoleLabel(LISTING_REF, USER_ID, 'member-1', {
          roleLabel: 'Barber',
        }),
      () => service.remove(LISTING_REF, USER_ID, 'member-1'),
    ];

    for (const route of routes) {
      scenario.teamRow = otherListingRow();
      await expect(refusalOf(route())).resolves.toMatchObject({
        statusCode: 404,
        code: 'listing_team_link_not_found',
      });
    }
    expect(manager.update).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it("keeps a hidden persona's row with a null persona so the business can remove it", async () => {
    const hiddenRow = teamRow({
      id: 'member-hidden',
      subprofileId: 'persona-hidden',
      status: ListingTeamMemberStatus.Accepted,
      position: 1,
      answeredAt: new Date('2026-10-03T00:00:00.000Z'),
    });
    scenario.members = [hiddenRow];
    scenario.visiblePersonaRows = [];

    const list = await service.listForManager(LISTING_REF, USER_ID);

    expect(list.accepted).toHaveLength(1);
    expect(list.accepted[0]).toMatchObject({
      id: 'member-hidden',
      persona: null,
    });

    scenario.teamRow = { ...hiddenRow };
    await service.remove(LISTING_REF, USER_ID, 'member-hidden');

    expect(manager.update).toHaveBeenCalledWith(
      ListingTeamMember,
      { id: 'member-hidden' },
      { status: ListingTeamMemberStatus.Removed, position: null },
    );
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('sorts each list per the contract and counts the requests awaiting the business', async () => {
    scenario.members = [
      teamRow({
        id: 'request-old',
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
      }),
      teamRow({
        id: 'request-new',
        createdAt: new Date('2026-10-05T00:00:00.000Z'),
      }),
      teamRow({
        id: 'invite-1',
        initiatedBy: ListingTeamInitiator.Listing,
      }),
      teamRow({
        id: 'accepted-second',
        status: ListingTeamMemberStatus.Accepted,
        position: 2,
      }),
      teamRow({
        id: 'accepted-first',
        status: ListingTeamMemberStatus.Accepted,
        position: 1,
      }),
    ];

    const list = await service.listForManager(LISTING_REF, USER_ID);

    expect(list.awaitingYouCount).toBe(2);
    expect(list.requestsReceived.map((row) => row.id)).toEqual([
      'request-new',
      'request-old',
    ]);
    expect(list.invitesSent.map((row) => row.id)).toEqual(['invite-1']);
    expect(list.accepted.map((row) => row.id)).toEqual([
      'accepted-first',
      'accepted-second',
    ]);
    const personaSql = String(queriesContaining('ANY($1::uuid[])')[0]?.[0]);
    expect(personaSql).toContain(
      notBlockedEitherWaySql('$2', '"persona"."user_id"'),
    );
  });

  it('lists personas and members together, keeps position interleaved and counts persona requests only', async () => {
    scenario.members = [
      teamRow({
        id: 'persona-accepted',
        status: ListingTeamMemberStatus.Accepted,
        initiatedBy: ListingTeamInitiator.Listing,
        position: 2,
      }),
      memberTeamRow({
        id: 'member-accepted-first',
        status: ListingTeamMemberStatus.Accepted,
        position: 1,
      }),
      memberTeamRow({
        id: 'member-accepted-third',
        status: ListingTeamMemberStatus.Accepted,
        position: 3,
      }),
      memberTeamRow({
        id: 'member-invite',
        createdAt: new Date('2026-10-04T00:00:00.000Z'),
      }),
      teamRow({ id: 'persona-request' }),
    ];

    const list = await service.listForManager(LISTING_REF, USER_ID);

    expect(list.accepted.map((row) => [row.id, row.kind])).toEqual([
      ['member-accepted-first', 'member'],
      ['persona-accepted', 'persona'],
      ['member-accepted-third', 'member'],
    ]);
    expect(list.invitesSent.map((row) => [row.id, row.kind])).toEqual([
      ['member-invite', 'member'],
    ]);
    expect(list.requestsReceived.map((row) => row.id)).toEqual([
      'persona-request',
    ]);
    expect(list.awaitingYouCount).toBe(1);
    const memberRow = list.accepted[0];
    expect(memberRow).toHaveProperty('member.slug', MEMBER_SLUG);
    expect(memberRow).not.toHaveProperty('persona');
    expect(list.accepted[1]).not.toHaveProperty('member');
    const memberSql = String(
      queriesContaining('FROM "profiles" "member_profile"')[0]?.[0],
    );
    expect(memberSql).toContain(
      eligibleMemberSql('member_profile', 'member_user'),
    );
    expect(memberSql).toContain(
      notBlockedEitherWaySql('$2', '"member_profile"."user_id"'),
    );
    expect(memberSql).toContain(
      notHiddenFromViewerSql('$2', '"member_profile"."user_id"'),
    );
    expect(
      queriesContaining('FROM "profiles" "member_profile"')[0]?.[1],
    ).toEqual([[MEMBER_USER_ID], USER_ID]);
  });

  it('skips the member query when the team holds no member row and the persona query when it holds no persona row', async () => {
    scenario.members = [teamRow({ id: 'persona-request' })];
    await service.listForManager(LISTING_REF, USER_ID);
    expect(queriesContaining('FROM "profiles" "member_profile"')).toHaveLength(
      0,
    );

    manager.query.mockClear();
    scenario.members = [memberTeamRow({ id: 'member-invite' })];
    await service.listForManager(LISTING_REF, USER_ID);
    expect(queriesContaining('"persona"."user_id"')).toHaveLength(0);
  });

  it("keeps an ineligible, blocked, hidden or deactivated member's row with a null member so the business can remove it", async () => {
    scenario.members = [
      memberTeamRow({
        id: 'member-gone',
        status: ListingTeamMemberStatus.Accepted,
        position: 1,
      }),
      memberTeamRow({ id: 'member-gone-invite' }),
    ];
    scenario.visibleMemberRows = [];

    const list = await service.listForManager(LISTING_REF, USER_ID);

    expect(list.accepted).toHaveLength(1);
    expect(list.accepted[0]).toMatchObject({
      id: 'member-gone',
      kind: 'member',
      member: null,
    });
    expect(list.invitesSent[0]).toMatchObject({
      id: 'member-gone-invite',
      kind: 'member',
      member: null,
    });

    scenario.teamRow = memberTeamRow({
      id: 'member-gone',
      status: ListingTeamMemberStatus.Accepted,
      position: 1,
    });
    await service.remove(LISTING_REF, USER_ID, 'member-gone');
    expect(manager.update).toHaveBeenCalledWith(
      ListingTeamMember,
      { id: 'member-gone' },
      { status: ListingTeamMemberStatus.Removed, position: null },
    );
  });

  it('hides the avatar of a member who turned their photo off', async () => {
    scenario.members = [memberTeamRow({ id: 'member-invite' })];
    scenario.visibleMemberRows = [
      memberProfileRow({ avatar_url: 'avatars/ana.jpg', photo_visible: false }),
    ];

    const list = await service.listForManager(LISTING_REF, USER_ID);

    expect(list.invitesSent[0]).toMatchObject({
      member: { slug: MEMBER_SLUG, avatarUrl: null },
    });
    expect(list.invitesSent[0]?.member).not.toHaveProperty('avatarCrop');
  });

  describe('reorder', () => {
    it('accepts an order that names persona and member rows together', async () => {
      scenario.acceptedIds = ['persona-a', 'member-b', 'persona-c'];
      scenario.members = [
        teamRow({
          id: 'persona-a',
          status: ListingTeamMemberStatus.Accepted,
          position: 1,
        }),
        memberTeamRow({
          id: 'member-b',
          status: ListingTeamMemberStatus.Accepted,
          position: 2,
        }),
        teamRow({
          id: 'persona-c',
          status: ListingTeamMemberStatus.Accepted,
          position: 3,
        }),
      ];

      const result = await service.reorder(LISTING_REF, USER_ID, {
        memberIds: ['member-b', 'persona-c', 'persona-a'],
      });

      expect(queriesContaining('unnest(')[0]?.[1]).toEqual([
        LISTING_ID,
        ['member-b', 'persona-c', 'persona-a'],
      ]);
      expect(result.accepted.map((row) => row.kind).sort()).toEqual([
        'member',
        'persona',
        'persona',
      ]);
    });

    it('refuses an order that leaves a member row out', async () => {
      scenario.acceptedIds = ['persona-a', 'member-b'];

      await expect(
        refusalOf(
          service.reorder(LISTING_REF, USER_ID, { memberIds: ['persona-a'] }),
        ),
      ).resolves.toMatchObject({
        statusCode: 409,
        code: 'listing_team_order_mismatch',
      });
    });
    it('refuses an order that leaves out a member or names a stranger', async () => {
      scenario.acceptedIds = ['member-a', 'member-b'];

      await expect(
        refusalOf(
          service.reorder(LISTING_REF, USER_ID, { memberIds: ['member-a'] }),
        ),
      ).resolves.toMatchObject({
        statusCode: 409,
        code: 'listing_team_order_mismatch',
      });
      await expect(
        refusalOf(
          service.reorder(LISTING_REF, USER_ID, {
            memberIds: ['member-a', 'stranger'],
          }),
        ),
      ).resolves.toMatchObject({
        statusCode: 409,
        code: 'listing_team_order_mismatch',
      });
      expect(queriesContaining('unnest(')).toHaveLength(0);
    });

    it('writes positions in the given order in one statement', async () => {
      scenario.acceptedIds = ['member-a', 'member-b', 'member-c'];

      await service.reorder(LISTING_REF, USER_ID, {
        memberIds: ['member-c', 'member-a', 'member-b'],
      });

      const reorderCalls = queriesContaining('unnest(');
      expect(reorderCalls).toHaveLength(1);
      expect(String(reorderCalls[0]?.[0])).toContain('WITH ORDINALITY');
      expect(reorderCalls[0]?.[1]).toEqual([
        LISTING_ID,
        ['member-c', 'member-a', 'member-b'],
      ]);
      expect(journal.indexOf('lock listings')).toBeLessThan(
        journal.indexOf('commit'),
      );
    });

    it('skips a row that ended between the read and the reorder', async () => {
      scenario.acceptedIds = ['member-a', 'member-b'];

      await service.reorder(LISTING_REF, USER_ID, {
        memberIds: ['member-b', 'member-a'],
      });

      const reorderSql = String(queriesContaining('unnest(')[0]?.[0]);
      const whereClause = reorderSql.slice(reorderSql.indexOf('WHERE'));
      expect(whereClause).toContain('"member"."listing_id" = $1');
      expect(whereClause).toContain(
        `"member"."status" = '${ListingTeamMemberStatus.Accepted}'`,
      );
    });
  });

  it('finds candidates by name or handle prefix, leaves blocked owners out and marks the pair', async () => {
    scenario.candidateRows = [
      { ...personaRow(), team_status: ListingTeamMemberStatus.Accepted },
      {
        ...personaRow({
          id: 'persona-2',
          handle: 'offcuts',
          link_visibility: SubprofileLinkVisibility.Linked,
          owner_first_name: 'Rui',
          owner_last_name: 'Mendes',
        }),
        team_status: null,
      },
    ];

    const result = await service.searchCandidates(
      LISTING_REF,
      USER_ID,
      '50%_off',
    );

    const searchCall = queriesContaining('ILIKE')[0];
    const sql = String(searchCall?.[0]);
    const parameters = searchCall?.[1] as unknown[];
    expect(sql).toContain(`"persona"."display_name" ILIKE $2 ESCAPE '\\'`);
    expect(sql).toContain(`"persona"."handle" ILIKE $5 ESCAPE '\\'`);
    expect(sql).toContain(notBlockedEitherWaySql('$4', '"persona"."user_id"'));
    expect(sql).toContain(notBlockedEitherWaySql('$6', '"persona"."user_id"'));
    expect(sql).toContain('lower($3)');
    expect(sql).toContain('LIMIT 20');
    expect(sql).toContain('ON "owner_profile"."user_id" = "persona"."user_id"');
    expect(sql).toContain(`AND "persona"."link_visibility" = 'linked'`);
    expect(parameters).toEqual([
      LISTING_ID,
      '%50\\%\\_off%',
      '50%_off',
      USER_ID,
      '50\\%\\_off%',
      USER_ID,
    ]);
    expect(result.items).toEqual([
      expect.objectContaining({
        persona: expect.objectContaining({
          id: PERSONA_ID,
          ownerName: null,
        }) as unknown,
        teamStatus: 'accepted',
      }),
      expect.objectContaining({
        persona: expect.objectContaining({
          id: 'persona-2',
          ownerName: 'Rui Mendes',
        }) as unknown,
        teamStatus: null,
      }),
    ]);
  });

  it("leaves out personas whose owner has a block with the listing's owner", async () => {
    scenario.listingOwnerId = LISTING_OWNER_ID;

    await service.searchCandidates(LISTING_REF, USER_ID, 'ink');

    const searchCall = queriesContaining('ILIKE')[0];
    const sql = String(searchCall?.[0]);
    const parameters = searchCall?.[1] as unknown[];
    expect(sql).toContain(notBlockedEitherWaySql('$6', '"persona"."user_id"'));
    expect(parameters[3]).toBe(USER_ID);
    expect(parameters[5]).toBe(LISTING_OWNER_ID);
  });

  it('adds an always-true owner term when the listing has no owner', async () => {
    scenario.listingOwnerId = null;

    await service.searchCandidates(LISTING_REF, USER_ID, 'ink');

    const parameters = queriesContaining('ILIKE')[0]?.[1] as unknown[];
    // A null owner equals no blocker or blocked id, so NOT EXISTS holds.
    expect(parameters).toHaveLength(6);
    expect(parameters[5]).toBeNull();
  });
});
