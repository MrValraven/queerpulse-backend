import { FindOperator, QueryFailedError } from 'typeorm';
import { ListingCoManagerStatus } from '../listings/entities/listing-co-manager.entity';
import { seatExcludedFromMailboxPredicate } from '../messaging/mailbox-seats';
import { IdentityKind } from './entities/identity.entity';
import { IdentitiesService } from './identities.service';

/**
 * Task 15: `IdentitiesService.listMailboxesFor`, the list behind
 * `GET /identities/mailboxes`. Every repository here is an in-memory table
 * that answers `find`/`findOne` by matching its `where` (equality, `In`, and
 * an array of alternatives), so the reverse lookup and the send path's own
 * `isAllowedToActAs` are checked against the SAME rows.
 */

const MEMBER_ID = 'member-user';
const OTHER_OWNER_ID = 'other-owner';

type Row = Record<string, unknown>;

function matchesValue(expected: unknown, actual: unknown): boolean {
  if (expected instanceof FindOperator) {
    if (expected.type === 'in') {
      return (expected.value as unknown[]).includes(actual);
    }
    throw new Error(`unsupported operator ${expected.type}`);
  }
  return expected === actual;
}

function matchesWhere(where: Row | Row[] | undefined, row: Row): boolean {
  if (!where) {
    return true;
  }
  if (Array.isArray(where)) {
    return where.some((alternative) => matchesWhere(alternative, row));
  }
  return Object.entries(where).every(([column, expected]) =>
    matchesValue(expected, row[column]),
  );
}

/** An in-memory table with the `find`/`findOne` calls counted. */
function makeTable(rows: Row[]) {
  return {
    rows,
    find: jest.fn((options?: { where?: Row | Row[] }) =>
      Promise.resolve(rows.filter((row) => matchesWhere(options?.where, row))),
    ),
    findOne: jest.fn((options?: { where?: Row | Row[] }) =>
      Promise.resolve(
        rows.find((row) => matchesWhere(options?.where, row)) ?? null,
      ),
    ),
  };
}

interface InsertBuilderMock {
  insert: jest.Mock;
  into: jest.Mock;
  values: jest.Mock;
  orIgnore: jest.Mock;
  execute: jest.Mock;
}

function makeForeignKeyViolation(): QueryFailedError {
  const driverError = Object.assign(new Error('foreign key violation'), {
    code: '23503',
  });
  return new QueryFailedError('insert', [], driverError);
}

/** The identities table, with the batched `INSERT ... ON CONFLICT DO
 *  NOTHING` that `ensureMailboxIdentities` issues for missing rows. Like the
 *  real statement it is atomic: one row whose owner no longer exists
 *  (`hasOwnerRow` false) fails the whole batch with a foreign key violation. */
function makeIdentitiesTable(
  rows: Row[],
  hasOwnerRow: (values: Row) => boolean = () => true,
) {
  const table = makeTable(rows);
  let createdCount = 0;
  const insertedBatches: Row[][] = [];
  const insertBuilder: InsertBuilderMock = {
    insert: jest.fn((): InsertBuilderMock => insertBuilder),
    into: jest.fn((): InsertBuilderMock => insertBuilder),
    values: jest.fn((values: Row[]): InsertBuilderMock => {
      insertedBatches.push(values);
      return insertBuilder;
    }),
    orIgnore: jest.fn((): InsertBuilderMock => insertBuilder),
    execute: jest.fn(() => {
      if (!insertedBatches[insertedBatches.length - 1]!.every(hasOwnerRow)) {
        return Promise.reject(makeForeignKeyViolation());
      }
      for (const values of insertedBatches[insertedBatches.length - 1]!) {
        createdCount += 1;
        rows.push({
          id: `created-identity-${createdCount}`,
          userId: null,
          listingId: null,
          subprofileId: null,
          companyId: null,
          ...values,
        });
      }
      return Promise.resolve({});
    }),
  };
  return {
    ...table,
    createQueryBuilder: jest.fn(() => insertBuilder),
    insertBuilder,
    insertedBatches,
  };
}

/** The participants repository: a chainable stand-in for the one grouped
 *  unread query, answering with `unreadRows`. */
function makeParticipants(
  unreadRows: Array<{ identityId: string; count: string }>,
) {
  const query = {} as Record<string, jest.Mock>;
  const self = () => query;
  for (const method of [
    'select',
    'addSelect',
    'innerJoin',
    'where',
    'andWhere',
    'setParameter',
    'groupBy',
  ]) {
    query[method] = jest.fn(self);
  }
  query.getRawMany = jest.fn().mockResolvedValue(unreadRows);
  return { createQueryBuilder: jest.fn(() => query), query };
}

function identityRow(
  id: string,
  kind: IdentityKind,
  ownerColumn: 'userId' | 'listingId' | 'subprofileId' | 'companyId',
  ownerEntityId: string,
  shouldShowStaffNames = true,
): Row {
  return {
    id,
    kind,
    userId: null,
    listingId: null,
    subprofileId: null,
    companyId: null,
    shouldShowStaffNames,
    [ownerColumn]: ownerEntityId,
  };
}

/**
 * One member who staffs a bit of everything:
 * - owns "Zebra Bar" and "Cafe Lisboa", co-manages "Bookshop" (active) and
 *   holds only an unanswered invitation to "Gym";
 * - owns the persona "Drag Name" and co-owns "Band";
 * - owns the company "Acme" and is on the team of "Globex".
 * Plus one listing, "Stranger Shop", they have nothing to do with.
 */
function makeFixture(
  options: {
    identities?: Row[];
    unreadRows?: Array<{ identityId: string; count: string }>;
    preferenceRows?: Row[];
  } = {},
) {
  const listings = makeTable([
    {
      id: 'zebra',
      ownerId: MEMBER_ID,
      name: 'Zebra Bar',
      slug: 'zebra',
      photoGallery: [],
    },
    {
      id: 'cafe',
      ownerId: MEMBER_ID,
      name: 'Cafe Lisboa',
      slug: 'cafe',
      photoGallery: [],
    },
    {
      id: 'bookshop',
      ownerId: OTHER_OWNER_ID,
      name: 'Bookshop',
      slug: 'bookshop',
      photoGallery: [],
    },
    {
      id: 'gym',
      ownerId: OTHER_OWNER_ID,
      name: 'Gym',
      slug: 'gym',
      photoGallery: [],
    },
    {
      id: 'stranger',
      ownerId: OTHER_OWNER_ID,
      name: 'Stranger Shop',
      slug: 'stranger',
      photoGallery: [],
    },
  ]);
  const listingCoManagers = makeTable([
    {
      listingId: 'bookshop',
      userId: MEMBER_ID,
      status: ListingCoManagerStatus.Active,
    },
    {
      listingId: 'gym',
      userId: MEMBER_ID,
      status: ListingCoManagerStatus.Invited,
    },
  ]);
  const subprofiles = makeTable([
    {
      id: 'drag',
      userId: MEMBER_ID,
      displayName: 'Drag Name',
      handle: 'drag',
      avatarUrl: null,
    },
    {
      id: 'band',
      userId: OTHER_OWNER_ID,
      displayName: 'Band',
      handle: 'band',
      avatarUrl: null,
    },
  ]);
  // A persona's creator holds a roster row from creation on, as
  // `SubprofilesService` inserts it; "Band"'s creator is not the member here.
  const subprofileMembers = makeTable([
    { subprofileId: 'drag', userId: MEMBER_ID },
    { subprofileId: 'band', userId: OTHER_OWNER_ID },
    { subprofileId: 'band', userId: MEMBER_ID },
  ]);
  const companies = makeTable([
    { id: 'acme', ownerId: MEMBER_ID, nameText: 'Acme', slug: 'acme' },
    {
      id: 'globex',
      ownerId: OTHER_OWNER_ID,
      nameText: 'Globex',
      slug: 'globex',
    },
  ]);
  const companyTeamMembers = makeTable([
    { companyId: 'globex', userId: MEMBER_ID },
  ]);
  const profiles = makeTable([
    {
      userId: MEMBER_ID,
      firstName: 'Tiago',
      lastName: 'Costa',
      slug: 'tiago',
      avatarUrl: null,
    },
  ]);
  const hasOwnerRow = (values: Row) =>
    (values.listingId == null ||
      listings.rows.some((row) => row.id === values.listingId)) &&
    (values.subprofileId == null ||
      subprofiles.rows.some((row) => row.id === values.subprofileId)) &&
    (values.companyId == null ||
      companies.rows.some((row) => row.id === values.companyId));
  const identities = makeIdentitiesTable(
    options.identities ?? [
      identityRow(
        'profile-identity',
        IdentityKind.Profile,
        'userId',
        MEMBER_ID,
      ),
      identityRow('zebra-identity', IdentityKind.Listing, 'listingId', 'zebra'),
      identityRow('cafe-identity', IdentityKind.Listing, 'listingId', 'cafe'),
      identityRow(
        'bookshop-identity',
        IdentityKind.Listing,
        'listingId',
        'bookshop',
      ),
      identityRow('gym-identity', IdentityKind.Listing, 'listingId', 'gym'),
      identityRow(
        'stranger-identity',
        IdentityKind.Listing,
        'listingId',
        'stranger',
      ),
      identityRow(
        'drag-identity',
        IdentityKind.Subprofile,
        'subprofileId',
        'drag',
      ),
      identityRow(
        'band-identity',
        IdentityKind.Subprofile,
        'subprofileId',
        'band',
      ),
      identityRow('acme-identity', IdentityKind.Company, 'companyId', 'acme'),
      identityRow(
        'globex-identity',
        IdentityKind.Company,
        'companyId',
        'globex',
      ),
    ],
    hasOwnerRow,
  );
  const participants = makeParticipants(options.unreadRows ?? []);
  const preferences = makeTable(options.preferenceRows ?? []);
  const service = new IdentitiesService(
    identities as never,
    listings as never,
    listingCoManagers as never,
    subprofiles as never,
    subprofileMembers as never,
    companies as never,
    companyTeamMembers as never,
    profiles as never,
    participants as never,
    preferences as never,
  );
  const tables = {
    identities,
    listings,
    listingCoManagers,
    subprofiles,
    subprofileMembers,
    companies,
    companyTeamMembers,
    profiles,
    preferences,
  };
  const queryCount = () =>
    Object.values(tables).reduce(
      (total, table) =>
        total + table.find.mock.calls.length + table.findOne.mock.calls.length,
      0,
    ) +
    identities.insertBuilder.execute.mock.calls.length +
    participants.query.getRawMany!.mock.calls.length;
  return { service, participants, queryCount, ...tables };
}

describe('IdentitiesService.listMailboxesFor', () => {
  it('lists the profile mailbox first, then listings, personas and companies, each by name', async () => {
    const { service } = makeFixture();

    const mailboxes = await service.listMailboxesFor(MEMBER_ID);

    expect(
      mailboxes.map((mailbox) => [mailbox.kind, mailbox.displayName]),
    ).toEqual([
      [IdentityKind.Profile, 'Tiago Costa'],
      [IdentityKind.Listing, 'Bookshop'],
      [IdentityKind.Listing, 'Cafe Lisboa'],
      [IdentityKind.Listing, 'Zebra Bar'],
      [IdentityKind.Subprofile, 'Band'],
      [IdentityKind.Subprofile, 'Drag Name'],
      [IdentityKind.Company, 'Acme'],
      [IdentityKind.Company, 'Globex'],
    ]);
  });

  it('marks the owner of each mailbox, and never a co-manager, persona co-owner or team member', async () => {
    const { service } = makeFixture();

    const mailboxes = await service.listMailboxesFor(MEMBER_ID);

    expect(
      Object.fromEntries(
        mailboxes.map((mailbox) => [mailbox.identityId, mailbox.isOwner]),
      ),
    ).toEqual({
      'profile-identity': true,
      'zebra-identity': true,
      'cafe-identity': true,
      'bookshop-identity': false,
      'drag-identity': true,
      'band-identity': false,
      'acme-identity': true,
      'globex-identity': false,
    });
  });

  it('offers exactly the mailboxes the send path lets this member act as', async () => {
    const fixture = makeFixture();

    const listedIdentityIds = (
      await fixture.service.listMailboxesFor(MEMBER_ID)
    ).map((mailbox) => mailbox.identityId);

    const acceptedIdentityIds: string[] = [];
    for (const identity of fixture.identities.rows) {
      if (
        await fixture.service.isAllowedToActAs(MEMBER_ID, String(identity.id))
      ) {
        acceptedIdentityIds.push(String(identity.id));
      }
    }
    expect([...listedIdentityIds].sort()).toEqual(
      [...acceptedIdentityIds].sort(),
    );
    // An unanswered co-manager invitation and an unrelated listing are refused
    // by both.
    expect(listedIdentityIds).not.toContain('gym-identity');
    expect(listedIdentityIds).not.toContain('stranger-identity');
  });

  it('lists a mailbox once, as its owner, for an owner who also holds a co-manager row', async () => {
    const fixture = makeFixture();
    fixture.listingCoManagers.rows.push({
      listingId: 'cafe',
      userId: MEMBER_ID,
      status: ListingCoManagerStatus.Active,
    });

    const cafeMailboxes = (
      await fixture.service.listMailboxesFor(MEMBER_ID)
    ).filter((mailbox) => mailbox.identityId === 'cafe-identity');

    expect(cafeMailboxes).toEqual([expect.objectContaining({ isOwner: true })]);
  });

  // Final review C1: `leave` deletes a departing creator's roster row and
  // keeps `subprofiles.user_id`, so the switcher must read the roster.
  it('leaves out a persona its creator has left, and the send path refuses it too', async () => {
    const fixture = makeFixture();
    fixture.subprofileMembers.rows.splice(
      fixture.subprofileMembers.rows.findIndex(
        (row) => row.subprofileId === 'drag' && row.userId === MEMBER_ID,
      ),
      1,
    );

    const listedIdentityIds = (
      await fixture.service.listMailboxesFor(MEMBER_ID)
    ).map((mailbox) => mailbox.identityId);

    expect(listedIdentityIds).not.toContain('drag-identity');
    expect(listedIdentityIds).toContain('band-identity');
    await expect(
      fixture.service.isAllowedToActAs(MEMBER_ID, 'drag-identity'),
    ).resolves.toBe(false);
  });

  it('returns only the profile mailbox for a member who staffs nothing', async () => {
    const { service } = makeFixture();

    const mailboxes = await service.listMailboxesFor('plain-user');

    expect(mailboxes).toHaveLength(1);
    expect(mailboxes[0]).toEqual(
      expect.objectContaining({ kind: IdentityKind.Profile, isOwner: true }),
    );
  });

  it('reads each unread count from the grouped query, and zero for a mailbox with no row', async () => {
    const { service } = makeFixture({
      unreadRows: [
        { identityId: 'profile-identity', count: '3' },
        { identityId: 'cafe-identity', count: '2' },
      ],
    });

    const unreadById = Object.fromEntries(
      (await service.listMailboxesFor(MEMBER_ID)).map((mailbox) => [
        mailbox.identityId,
        mailbox.unreadCount,
      ]),
    );

    expect(unreadById['profile-identity']).toBe(3);
    expect(unreadById['cafe-identity']).toBe(2);
    expect(unreadById['zebra-identity']).toBe(0);
  });

  it("counts unread over the member's own seats in exactly the listed mailboxes, leaving out every seat excluded from its thread", async () => {
    const { service, participants } = makeFixture();

    const mailboxes = await service.listMailboxesFor(MEMBER_ID);

    const { query } = participants;
    expect(query.where).toHaveBeenCalledWith('p.user_id = :userId', {
      userId: MEMBER_ID,
    });
    const identityFilter = query.andWhere!.mock.calls.find((call: unknown[]) =>
      String(call[0]).includes('p.identity_id IN'),
    ) as [string, { mailboxIdentityIds: string[] }];
    expect([...identityFilter[1].mailboxIdentityIds].sort()).toEqual(
      mailboxes.map((mailbox) => mailbox.identityId).sort(),
    );
    expect(query.andWhere).toHaveBeenCalledWith(
      `NOT ${seatExcludedFromMailboxPredicate('p.conversation_id', ':userId')}`,
    );
    expect(query.groupBy).toHaveBeenCalledWith('p.identity_id');
  });

  it('costs the same number of queries for one mailbox as for many', async () => {
    const plain = makeFixture({
      identities: [
        identityRow(
          'plain-identity',
          IdentityKind.Profile,
          'userId',
          'plain-user',
        ),
      ],
    });
    await plain.service.listMailboxesFor('plain-user');

    const busy = makeFixture();
    const describeSpy = jest.spyOn(busy.service, 'describeIdentities');
    await busy.service.listMailboxesFor(MEMBER_ID);

    expect(busy.queryCount()).toBe(plain.queryCount() + 4);
    // Three of the four extra are `describeIdentities` reading the listing,
    // persona and company tables once each, which the plain member never
    // needs. The fourth is the one read of which personas moderation removed
    // (`isReadOnly`), which runs only when some persona mailbox is listed.
    // Everything else is one call each.
    expect(describeSpy).toHaveBeenCalledTimes(1);
    expect(busy.participants.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(busy.identities.insertBuilder.execute).not.toHaveBeenCalled();
  });

  it('creates every missing identity row in one batched insert, and every summary carries its identity id', async () => {
    const fixture = makeFixture({
      identities: [
        identityRow(
          'profile-identity',
          IdentityKind.Profile,
          'userId',
          MEMBER_ID,
        ),
      ],
    });

    const mailboxes = await fixture.service.listMailboxesFor(MEMBER_ID);

    expect(fixture.identities.insertBuilder.execute).toHaveBeenCalledTimes(1);
    expect(fixture.identities.insertBuilder.orIgnore).toHaveBeenCalledTimes(1);
    expect(fixture.identities.insertedBatches[0]).toHaveLength(7);
    expect(mailboxes).toHaveLength(8);
    for (const mailbox of mailboxes) {
      expect(mailbox.identityId).toEqual(expect.any(String));
    }
    expect(
      mailboxes.find((mailbox) => mailbox.displayName === 'Cafe Lisboa'),
    ).toEqual(expect.objectContaining({ kind: IdentityKind.Listing }));
  });

  it('keeps a mailbox whose owner row was deleted between the staffing read and the description, with no display data', async () => {
    // Guards the race with a hard delete: the listing row is gone, and the
    // identity and co-manager rows its delete cascades to are still read.
    const fixture = makeFixture();
    fixture.listings.rows.splice(
      fixture.listings.rows.findIndex((row) => row.id === 'bookshop'),
      1,
    );

    const bookshop = (await fixture.service.listMailboxesFor(MEMBER_ID)).find(
      (mailbox) => mailbox.identityId === 'bookshop-identity',
    );

    expect(bookshop).toEqual(
      expect.objectContaining({
        displayName: null,
        handle: null,
        avatarUrl: null,
        isOwner: false,
      }),
    );
  });

  it('inserts missing identity rows in one fixed order, by kind and owner id, so concurrent inserts cannot deadlock', async () => {
    const fixture = makeFixture({ identities: [] });

    await fixture.service.listMailboxesFor(MEMBER_ID);

    const insertedKeys = fixture.identities.insertedBatches[0]!.map(
      (values) =>
        `${String(values.kind)}:${String(
          values.userId ??
            values.listingId ??
            values.subprofileId ??
            values.companyId,
        )}`,
    );
    expect(insertedKeys).toEqual([...insertedKeys].sort());
  });

  it('breaks a tie between equal names on the identity id, so the order is the same on every request', async () => {
    const fixture = makeFixture();
    fixture.listings.rows.push({
      id: 'cafe-two',
      ownerId: MEMBER_ID,
      name: 'Cafe Lisboa',
      slug: 'cafe-two',
      photoGallery: [],
    });
    fixture.identities.rows.push(
      identityRow(
        'aaa-cafe-identity',
        IdentityKind.Listing,
        'listingId',
        'cafe-two',
      ),
    );

    const cafeIdentityIds = (await fixture.service.listMailboxesFor(MEMBER_ID))
      .filter((mailbox) => mailbox.displayName === 'Cafe Lisboa')
      .map((mailbox) => mailbox.identityId);

    expect(cafeIdentityIds).toEqual(['aaa-cafe-identity', 'cafe-identity']);
  });

  it('drops a mailbox whose owner was hard-deleted before its identity row could be created, and lists the rest', async () => {
    const fixture = makeFixture({
      identities: [
        identityRow(
          'profile-identity',
          IdentityKind.Profile,
          'userId',
          MEMBER_ID,
        ),
      ],
    });
    // The listing is deleted after the co-manager row was read: the insert
    // naming it violates the listing foreign key.
    fixture.listings.rows.splice(
      fixture.listings.rows.findIndex((row) => row.id === 'bookshop'),
      1,
    );

    const mailboxes = await fixture.service.listMailboxesFor(MEMBER_ID);

    expect(fixture.identities.insertBuilder.execute).toHaveBeenCalledTimes(2);
    expect(mailboxes.map((mailbox) => mailbox.displayName)).toEqual([
      'Tiago Costa',
      'Cafe Lisboa',
      'Zebra Bar',
      'Band',
      'Drag Name',
      'Acme',
      'Globex',
    ]);
  });

  it('still fails on an insert error other than a vanished owner', async () => {
    const fixture = makeFixture({ identities: [] });
    const connectionError = new Error('connection terminated');
    fixture.identities.insertBuilder.execute.mockRejectedValueOnce(
      connectionError,
    );

    await expect(fixture.service.listMailboxesFor(MEMBER_ID)).rejects.toBe(
      connectionError,
    );
  });

  it('marks a persona that moderation removed as read-only, and every other mailbox as writable', async () => {
    const fixture = makeFixture();
    fixture.subprofiles.rows.find((row) => row.id === 'band')!.removedAt =
      new Date('2026-09-01T00:00:00Z');

    const readOnlyById = Object.fromEntries(
      (await fixture.service.listMailboxesFor(MEMBER_ID)).map((mailbox) => [
        mailbox.identityId,
        mailbox.isReadOnly,
      ]),
    );

    expect(readOnlyById).toEqual({
      'profile-identity': false,
      'zebra-identity': false,
      'cafe-identity': false,
      'bookshop-identity': false,
      'drag-identity': false,
      'band-identity': true,
      'acme-identity': false,
      'globex-identity': false,
    });
  });

  it('leaves out a draft persona that has no conversation, since it was never published', async () => {
    const fixture = makeFixture();
    fixture.subprofiles.rows.find((row) => row.id === 'drag')!.status = 'draft';
    // The draft check runs before the unread count: no thread holds "drag".
    fixture.participants.query.getRawMany!.mockResolvedValueOnce([]);

    const listedIdentityIds = (
      await fixture.service.listMailboxesFor(MEMBER_ID)
    ).map((mailbox) => mailbox.identityId);

    expect(listedIdentityIds).not.toContain('drag-identity');
    expect(listedIdentityIds).toContain('band-identity');
  });

  it('keeps a draft persona that already has a conversation, so an unpublished persona keeps its threads', async () => {
    const fixture = makeFixture();
    fixture.subprofiles.rows.find((row) => row.id === 'drag')!.status = 'draft';
    fixture.participants.query.getRawMany!.mockResolvedValueOnce([
      { identityId: 'drag-identity' },
    ]);

    const listedIdentityIds = (
      await fixture.service.listMailboxesFor(MEMBER_ID)
    ).map((mailbox) => mailbox.identityId);

    expect(listedIdentityIds).toContain('drag-identity');
    expect(fixture.participants.createQueryBuilder).toHaveBeenCalledTimes(2);
  });

  it("fills shouldShowStaffNames from the identity's own column and shouldAllowMyName from one preference query, defaulting true when the caller's row is absent", async () => {
    const fixture = makeFixture({
      identities: [
        identityRow(
          'profile-identity',
          IdentityKind.Profile,
          'userId',
          MEMBER_ID,
        ),
        identityRow(
          'zebra-identity',
          IdentityKind.Listing,
          'listingId',
          'zebra',
        ),
        identityRow(
          'cafe-identity',
          IdentityKind.Listing,
          'listingId',
          'cafe',
          false,
        ),
      ],
      preferenceRows: [
        {
          identityId: 'cafe-identity',
          userId: MEMBER_ID,
          shouldAllowNaming: false,
        },
      ],
    });

    const mailboxes = await fixture.service.listMailboxesFor(MEMBER_ID);
    const checkedMailboxIds = new Set([
      'profile-identity',
      'zebra-identity',
      'cafe-identity',
    ]);

    expect(
      Object.fromEntries(
        mailboxes
          .filter((mailbox) => checkedMailboxIds.has(mailbox.identityId))
          .map((mailbox) => [
            mailbox.identityId,
            {
              shouldShowStaffNames: mailbox.shouldShowStaffNames,
              shouldAllowMyName: mailbox.shouldAllowMyName,
            },
          ]),
      ),
    ).toEqual({
      'profile-identity': {
        shouldShowStaffNames: null,
        shouldAllowMyName: null,
      },
      'zebra-identity': {
        shouldShowStaffNames: true,
        shouldAllowMyName: true,
      },
      'cafe-identity': {
        shouldShowStaffNames: false,
        shouldAllowMyName: false,
      },
    });
    expect(fixture.preferences.find).toHaveBeenCalledTimes(1);
  });
});
