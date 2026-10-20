import { HttpException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import {
  ListingTeamInitiator,
  ListingTeamMember,
  ListingTeamMemberStatus,
} from './entities/listing-team-member.entity';
import { eligiblePersonaSql } from './listing-team-visibility';
import {
  assertAcceptedRoom,
  assertInviteRoom,
  assertPairOpen,
  assertRequestRoom,
  hasBlockEitherWay,
  insertLiveTeamRow,
  lockListingRow,
  lockPersonaRow,
  type NewTeamRowValues,
  readPersonaFacts,
} from './listing-team-write-rules';

const LISTING_ID = 'listing-1';
const SUBPROFILE_ID = 'persona-1';

interface ManagerMock {
  query: jest.Mock;
  findOne: jest.Mock;
  findOneOrFail: jest.Mock;
  count: jest.Mock;
  save: jest.Mock;
  create: jest.Mock;
}

const buildManager = (): ManagerMock => ({
  query: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
  findOneOrFail: jest.fn(),
  count: jest.fn().mockResolvedValue(0),
  save: jest.fn((entity: object) => Promise.resolve(entity)),
  create: jest.fn(),
});

const asManager = (manager: ManagerMock): EntityManager =>
  manager as unknown as EntityManager;

const teamRow = (overrides: Partial<ListingTeamMember>): ListingTeamMember => ({
  id: 'member-1',
  listingId: LISTING_ID,
  subprofileId: SUBPROFILE_ID,
  roleLabel: null,
  status: ListingTeamMemberStatus.Pending,
  initiatedBy: ListingTeamInitiator.Listing,
  requestedByUserId: 'owner-1',
  answeredAt: null,
  position: null,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  ...overrides,
});

const personaRequestValues = (): NewTeamRowValues => ({
  listingId: LISTING_ID,
  subprofileId: SUBPROFILE_ID,
  initiatedBy: ListingTeamInitiator.Persona,
  requestedByUserId: 'persona-owner-1',
  roleLabel: null,
  status: ListingTeamMemberStatus.Pending,
  position: null,
  answeredAt: null,
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

const sqlOfCall = (manager: ManagerMock, callIndex: number): string =>
  String(manager.query.mock.calls[callIndex]?.[0] ?? '');

const parametersOfCall = (manager: ManagerMock, callIndex: number): unknown =>
  manager.query.mock.calls[callIndex]?.[1];

describe('listing team write rules', () => {
  let manager: ManagerMock;

  beforeEach(() => {
    manager = buildManager();
  });

  it('locks the listing row before the persona row', async () => {
    manager.query
      .mockResolvedValueOnce([{ id: LISTING_ID }])
      .mockResolvedValueOnce([{ id: SUBPROFILE_ID }]);

    await lockListingRow(asManager(manager), LISTING_ID);
    await expect(
      lockPersonaRow(asManager(manager), SUBPROFILE_ID),
    ).resolves.toBe(true);

    expect(manager.query).toHaveBeenCalledTimes(2);
    const listingSql = sqlOfCall(manager, 0);
    const personaSql = sqlOfCall(manager, 1);
    expect(listingSql).toContain('FROM "listings"');
    expect(listingSql.trim().endsWith('FOR UPDATE')).toBe(true);
    expect(parametersOfCall(manager, 0)).toEqual([LISTING_ID]);
    expect(personaSql).toContain('FROM "subprofiles"');
    expect(personaSql.trim().endsWith('FOR UPDATE')).toBe(true);
    expect(parametersOfCall(manager, 1)).toEqual([SUBPROFILE_ID]);
  });

  it('answers false when the persona row is gone and nothing was locked', async () => {
    await expect(
      lockPersonaRow(asManager(manager), SUBPROFILE_ID),
    ).resolves.toBe(false);
    expect(parametersOfCall(manager, 0)).toEqual([SUBPROFILE_ID]);
  });

  it('refuses an accepted pair before a pending one, and a pending one with its direction', async () => {
    manager.findOne.mockResolvedValueOnce(
      teamRow({ status: ListingTeamMemberStatus.Accepted, position: 1 }),
    );
    await expect(
      refusalOf(
        assertPairOpen(
          asManager(manager),
          LISTING_ID,
          SUBPROFILE_ID,
          ListingTeamInitiator.Listing,
        ),
      ),
    ).resolves.toMatchObject({
      statusCode: 409,
      code: 'listing_team_already_accepted',
    });

    manager.findOne.mockResolvedValueOnce(
      teamRow({
        status: ListingTeamMemberStatus.Pending,
        initiatedBy: ListingTeamInitiator.Persona,
      }),
    );
    await expect(
      refusalOf(
        assertPairOpen(
          asManager(manager),
          LISTING_ID,
          SUBPROFILE_ID,
          ListingTeamInitiator.Listing,
        ),
      ),
    ).resolves.toMatchObject({
      statusCode: 409,
      code: 'listing_team_already_pending',
      initiatedBy: 'persona',
    });
    expect(manager.query).not.toHaveBeenCalled();
  });

  it('refuses a re-ask inside the cooldown with the retry date and keys it on the side', async () => {
    const retryAt = new Date('2026-11-02T10:00:00.000Z');
    manager.query.mockResolvedValueOnce([{ retry_at: retryAt }]);

    await expect(
      refusalOf(
        assertPairOpen(
          asManager(manager),
          LISTING_ID,
          SUBPROFILE_ID,
          ListingTeamInitiator.Listing,
        ),
      ),
    ).resolves.toMatchObject({
      statusCode: 409,
      code: 'listing_team_cooldown',
      retryAt: retryAt.toISOString(),
    });
    expect(sqlOfCall(manager, 0)).toContain(
      `"answered_at" + make_interval(days => $4) > now()`,
    );
    expect(parametersOfCall(manager, 0)).toEqual([
      LISTING_ID,
      SUBPROFILE_ID,
      'listing',
      14,
    ]);
  });

  it('lets an open pair through', async () => {
    await expect(
      assertPairOpen(
        asManager(manager),
        LISTING_ID,
        SUBPROFILE_ID,
        ListingTeamInitiator.Persona,
      ),
    ).resolves.toBeUndefined();
  });

  it('lets the 40th accepted member in and refuses the 41st', async () => {
    manager.count.mockResolvedValueOnce(39).mockResolvedValueOnce(0);
    await expect(
      assertAcceptedRoom(asManager(manager), LISTING_ID, SUBPROFILE_ID),
    ).resolves.toBeUndefined();

    manager.count.mockResolvedValueOnce(40);
    await expect(
      refusalOf(
        assertAcceptedRoom(asManager(manager), LISTING_ID, SUBPROFILE_ID),
      ),
    ).resolves.toMatchObject({ statusCode: 409, code: 'listing_team_full' });
    expect(manager.count).toHaveBeenLastCalledWith(ListingTeamMember, {
      where: {
        listingId: LISTING_ID,
        status: ListingTeamMemberStatus.Accepted,
      },
    });
  });

  it('lets the 10th listing in and refuses the 11th', async () => {
    manager.count.mockResolvedValueOnce(0).mockResolvedValueOnce(9);
    await expect(
      assertAcceptedRoom(asManager(manager), LISTING_ID, SUBPROFILE_ID),
    ).resolves.toBeUndefined();

    manager.count.mockResolvedValueOnce(0).mockResolvedValueOnce(10);
    await expect(
      refusalOf(
        assertAcceptedRoom(asManager(manager), LISTING_ID, SUBPROFILE_ID),
      ),
    ).resolves.toMatchObject({
      statusCode: 409,
      code: 'listing_team_persona_full',
    });
    expect(manager.count).toHaveBeenLastCalledWith(ListingTeamMember, {
      where: {
        subprofileId: SUBPROFILE_ID,
        status: ListingTeamMemberStatus.Accepted,
      },
    });
  });

  it('counts both directions toward the 40 pending', async () => {
    manager.count.mockResolvedValueOnce(39);
    await expect(
      assertInviteRoom(asManager(manager), LISTING_ID),
    ).resolves.toBeUndefined();

    manager.count.mockResolvedValueOnce(40);
    await expect(
      refusalOf(assertInviteRoom(asManager(manager), LISTING_ID)),
    ).resolves.toMatchObject({
      statusCode: 409,
      code: 'listing_team_pending_full',
    });

    manager.count.mockResolvedValueOnce(40);
    await expect(
      refusalOf(
        assertRequestRoom(asManager(manager), LISTING_ID, SUBPROFILE_ID),
      ),
    ).resolves.toMatchObject({ code: 'listing_team_pending_full' });

    // The listing count carries no direction filter, so invites and requests
    // both fill it.
    expect(manager.count).toHaveBeenCalledTimes(3);
    for (const call of manager.count.mock.calls) {
      expect(call).toEqual([
        ListingTeamMember,
        {
          where: {
            listingId: LISTING_ID,
            status: ListingTeamMemberStatus.Pending,
          },
        },
      ]);
    }
  });

  it('refuses the 11th pending request of a persona', async () => {
    manager.count.mockResolvedValueOnce(0).mockResolvedValueOnce(9);
    await expect(
      assertRequestRoom(asManager(manager), LISTING_ID, SUBPROFILE_ID),
    ).resolves.toBeUndefined();

    manager.count.mockResolvedValueOnce(0).mockResolvedValueOnce(10);
    await expect(
      refusalOf(
        assertRequestRoom(asManager(manager), LISTING_ID, SUBPROFILE_ID),
      ),
    ).resolves.toMatchObject({
      statusCode: 409,
      code: 'listing_team_persona_requests_full',
    });
    expect(manager.count).toHaveBeenLastCalledWith(ListingTeamMember, {
      where: {
        subprofileId: SUBPROFILE_ID,
        status: ListingTeamMemberStatus.Pending,
        initiatedBy: ListingTeamInitiator.Persona,
      },
    });
  });

  it("maps a live pair conflict to the pair's current refusal", async () => {
    manager.query.mockResolvedValueOnce([]);
    manager.findOne.mockResolvedValueOnce(
      teamRow({
        status: ListingTeamMemberStatus.Pending,
        initiatedBy: ListingTeamInitiator.Listing,
      }),
    );

    await expect(
      refusalOf(insertLiveTeamRow(asManager(manager), personaRequestValues())),
    ).resolves.toMatchObject({
      statusCode: 409,
      code: 'listing_team_already_pending',
      initiatedBy: 'listing',
    });
    expect(sqlOfCall(manager, 0)).toContain(
      `ON CONFLICT ("listing_id", "subprofile_id") WHERE "status" IN ('pending', 'accepted') DO NOTHING`,
    );
    expect(parametersOfCall(manager, 0)).toEqual([
      LISTING_ID,
      SUBPROFILE_ID,
      'persona',
      'persona-owner-1',
      null,
      'pending',
      null,
      null,
    ]);
    expect(manager.query).toHaveBeenCalledTimes(1);
    expect(manager.findOneOrFail).not.toHaveBeenCalled();
  });

  it('answers the already pending code when the conflict outlives the one retry', async () => {
    // Every insert comes back empty and every re-read finds the pair open.
    await expect(
      refusalOf(insertLiveTeamRow(asManager(manager), personaRequestValues())),
    ).resolves.toMatchObject({
      statusCode: 409,
      code: 'listing_team_already_pending',
      initiatedBy: 'persona',
    });
    // Insert, cooldown read, the retried insert, the second cooldown read.
    expect(manager.query).toHaveBeenCalledTimes(4);
    expect(sqlOfCall(manager, 2)).toContain('ON CONFLICT');
    expect(manager.findOneOrFail).not.toHaveBeenCalled();
  });

  it('answers the inserted row when the pair is free', async () => {
    const inserted = teamRow({ id: 'member-new' });
    manager.query.mockResolvedValueOnce([{ id: 'member-new' }]);
    manager.findOneOrFail.mockResolvedValueOnce(inserted);

    await expect(
      insertLiveTeamRow(asManager(manager), {
        listingId: LISTING_ID,
        subprofileId: SUBPROFILE_ID,
        initiatedBy: ListingTeamInitiator.Listing,
        requestedByUserId: 'owner-1',
        roleLabel: 'Chef',
        status: ListingTeamMemberStatus.Pending,
        position: null,
        answeredAt: null,
      }),
    ).resolves.toBe(inserted);
    expect(manager.findOneOrFail).toHaveBeenCalledWith(ListingTeamMember, {
      where: { id: 'member-new' },
    });
  });

  it('reads persona facts through the eligibility fragment', async () => {
    manager.query.mockResolvedValueOnce([
      { id: SUBPROFILE_ID, user_id: 'persona-owner-1', is_eligible: true },
    ]);

    await expect(
      readPersonaFacts(asManager(manager), SUBPROFILE_ID),
    ).resolves.toEqual({
      id: SUBPROFILE_ID,
      ownerUserId: 'persona-owner-1',
      isEligible: true,
    });
    expect(sqlOfCall(manager, 0)).toContain(eligiblePersonaSql('persona'));
    expect(parametersOfCall(manager, 0)).toEqual([SUBPROFILE_ID]);
  });

  it('sees no block between a member and themself or an unowned listing', async () => {
    await expect(hasBlockEitherWay(asManager(manager), 'a', 'a')).resolves.toBe(
      false,
    );
    await expect(
      hasBlockEitherWay(asManager(manager), 'a', null),
    ).resolves.toBe(false);
    expect(manager.query).not.toHaveBeenCalled();
  });
});
