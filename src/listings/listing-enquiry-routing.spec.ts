import { BadRequestException } from '@nestjs/common';
import { IdentityKind } from '../identities/entities/identity.entity';
import { MessageRequestsService } from '../messaging/message-requests.service';
import { MessagingCoreService } from '../messaging/messaging-core.service';
import { MessagingService } from '../messaging/messaging.service';
import { UserStatus } from '../users/entities/user.entity';
import { Listing, ListingStatus } from './entities/listing.entity';
import { ListingEnquiriesService } from './listing-enquiries.service';

/**
 * Task 18: a directory enquiry lands in the LISTING's mailbox. The real
 * `ListingEnquiriesService.send` runs through the real `MessagingService`
 * facade, `MessageRequestsService` and `MessagingCoreService` thread logic;
 * only storage, identities and cross-domain services are stubbed. What is
 * asserted is where the message goes, which a mocked messaging layer could
 * never show.
 */

interface SavedRow {
  [column: string]: unknown;
}

const LISTING_IDENTITY = 'listing-identity';
const MAILBOX_THREAD = `thread:${['profile-customer-user', LISTING_IDENTITY]
  .sort()
  .join(':')}`;

function makeRouting(
  options: {
    /** The listing's owner; null for a listing whose owner account is gone. */
    ownerUserId?: string | null;
    coManagerUserIds?: string[];
    staffIdentityIds?: Record<string, string[]>;
    personBlockedUserIds?: string[];
    suspendedUserIds?: string[];
  } = {},
) {
  const ownerUserId =
    options.ownerUserId === undefined ? 'owner-user' : options.ownerUserId;
  // Built the way `IdentitiesService.staffUserIds` builds a listing's staff:
  // the owner when there is one, then every active co-manager.
  const listingStaff = [
    ...(ownerUserId ? [ownerUserId] : []),
    ...(options.coManagerUserIds ?? []),
  ];
  const staffByIdentityId: Record<string, string[]> = {
    [LISTING_IDENTITY]: listingStaff,
    ...(options.staffIdentityIds ?? {}),
  };
  const savedConversations: SavedRow[] = [];
  const savedSeats: SavedRow[] = [];
  const identities = {
    getById: jest.fn((identityId: string) =>
      Promise.resolve(
        identityId.startsWith('profile-')
          ? { id: identityId, kind: IdentityKind.Profile }
          : { id: identityId, kind: IdentityKind.Listing },
      ),
    ),
    resolveProfileIdentityId: jest.fn((userId: string) =>
      Promise.resolve(`profile-${userId}`),
    ),
    staffUserIds: jest.fn((identityId: string) =>
      Promise.resolve(staffByIdentityId[identityId] ?? []),
    ),
    isRemovedPersona: jest.fn(() => Promise.resolve(false)),
    assertMayActAs: jest.fn(() => Promise.resolve()),
    ensureIdentityFor: jest.fn(() => Promise.resolve({ id: LISTING_IDENTITY })),
  };
  const core = Object.create(
    MessagingCoreService.prototype,
  ) as MessagingCoreService;
  const transaction = jest.fn((run: (manager: unknown) => Promise<unknown>) =>
    run({
      create: (_entity: unknown, row: SavedRow) => ({ ...row }),
      save: (rows: SavedRow | SavedRow[]) => {
        if (Array.isArray(rows)) {
          savedSeats.push(...rows);
          return Promise.resolve(rows);
        }
        // Named after its pair key, so an assertion on the id also says
        // which two identities the thread joins.
        const conversation = { ...rows, id: `thread:${String(rows.pairKey)}` };
        savedConversations.push(conversation);
        return Promise.resolve(conversation);
      },
    }),
  );
  const postMessage = jest.fn(() =>
    Promise.resolve({ view: {}, response: {}, isNew: true }),
  );
  Object.assign(core, {
    identities,
    conversations: {
      findOne: jest.fn(({ where }: { where: { pairKey: string } }) =>
        Promise.resolve(
          savedConversations.find(
            (conversation) => conversation.pairKey === where.pairKey,
          ) ?? null,
        ),
      ),
      update: jest.fn(() => Promise.resolve()),
    },
    dataSource: { transaction },
    postMessage,
  });
  const blockFilter = {
    isIdentityBlocked: jest.fn(() => Promise.resolve(false)),
    blockedUserIds: jest.fn((userId: string, candidateUserIds: string[]) =>
      Promise.resolve(
        new Set(
          candidateUserIds.filter(
            (candidateUserId) =>
              candidateUserId !== userId &&
              (options.personBlockedUserIds ?? []).includes(candidateUserId),
          ),
        ),
      ),
    ),
    isBlockedEitherWay: jest.fn((firstUserId: string, secondUserId: string) =>
      Promise.resolve(
        (options.personBlockedUserIds ?? []).some(
          (userId) => userId === firstUserId || userId === secondUserId,
        ),
      ),
    ),
  };
  // Every staff member's account, active unless the test suspends it. The
  // one repository both messaging and the listing read account status from.
  const users = {
    find: jest.fn(() =>
      Promise.resolve(
        listingStaff.map((staffUserId) => ({
          id: staffUserId,
          isSystem: false,
          status: (options.suspendedUserIds ?? []).includes(staffUserId)
            ? UserStatus.Suspended
            : UserStatus.Active,
        })),
      ),
    ),
  };
  const requests = new MessageRequestsService(
    {} as never,
    core,
    {
      areConnected: jest.fn(() => Promise.resolve(false)),
      assertRequestsNotPaused: jest.fn(() => Promise.resolve()),
    } as never,
    blockFilter as never,
    { resyncConversation: jest.fn(() => Promise.resolve([])) } as never,
    users as never,
  );
  const messaging = Object.create(
    MessagingService.prototype,
  ) as MessagingService;
  Object.assign(messaging, { messageRequestsService: requests });
  const deliverEnquiry = jest.spyOn(messaging, 'deliverEnquiry');
  const enquiries = {
    findOne: jest.fn(() => Promise.resolve(null)),
    find: jest.fn(() => Promise.resolve([])),
    // The persona and company cold messages the shared ceiling counts.
    query: jest.fn(() => Promise.resolve([])),
    create: jest.fn((row: SavedRow) => row),
    save: jest.fn((row: SavedRow) =>
      Promise.resolve({ id: 'enquiry-1', ...row }),
    ),
  };
  const listing = {
    id: 'listing-1',
    slug: 'drama-bar',
    name: 'Drama Bar',
    ownerId: ownerUserId,
    status: ListingStatus.Live,
    path: 'own',
    badge: 'owned',
    isHiddenByOwner: false,
  } as Listing;
  const service = new ListingEnquiriesService(
    { findOne: jest.fn(() => Promise.resolve(listing)) } as never,
    enquiries as never,
    users as never,
    messaging,
    { statesForAnyType: jest.fn(() => Promise.resolve(new Map())) } as never,
    identities as never,
  );
  return {
    service,
    savedConversations,
    savedSeats,
    postMessage,
    transaction,
    enquiries,
    deliverEnquiry,
    identities,
  };
}

describe('a directory enquiry lands in the listing mailbox', () => {
  it('opens the thread against the listing identity and seats every staff member', async () => {
    const { service, savedConversations, savedSeats, identities } = makeRouting(
      { coManagerUserIds: ['comanager-user'] },
    );

    await service.send('drama-bar', 'customer-user', {
      body: 'Is the upstairs room step-free?',
    });

    expect(identities.ensureIdentityFor).toHaveBeenCalledWith(
      IdentityKind.Listing,
      'listing-1',
    );
    expect(savedConversations[0]?.pairKey).toBe(
      ['profile-customer-user', LISTING_IDENTITY].sort().join(':'),
    );
    expect(savedSeats.map((seat) => [seat.userId, seat.identityId])).toEqual([
      ['customer-user', 'profile-customer-user'],
      ['owner-user', LISTING_IDENTITY],
      ['comanager-user', LISTING_IDENTITY],
    ]);
  });

  it('never delivers to the owner as a bare user id', async () => {
    const { service, deliverEnquiry, savedConversations } = makeRouting();

    await service.send('drama-bar', 'customer-user', {
      body: 'Is the upstairs room step-free?',
    });

    expect(deliverEnquiry).not.toHaveBeenCalled();
    expect(savedConversations[0]?.pairKey).not.toContain('owner-user');
  });

  it('records the enquiry row against the mailbox thread, keeping the owner snapshot', async () => {
    const { service, enquiries, postMessage } = makeRouting();

    const result = await service.send('drama-bar', 'customer-user', {
      body: 'Is the upstairs room step-free?',
    });

    expect(postMessage).toHaveBeenCalledWith(
      MAILBOX_THREAD,
      'customer-user',
      expect.stringContaining('Is the upstairs room step-free?'),
    );
    expect(enquiries.save).toHaveBeenCalledWith(
      expect.objectContaining({
        listingId: 'listing-1',
        senderId: 'customer-user',
        ownerId: 'owner-user',
        conversationId: MAILBOX_THREAD,
      }),
    );
    expect(result).toMatchObject({
      conversationId: MAILBOX_THREAD,
      followUpAwaitsReply: true,
    });
  });

  it('delivers although the member blocked the owner, whom it does not name, while a co-manager is reachable', async () => {
    const { service, postMessage } = makeRouting({
      coManagerUserIds: ['comanager-user'],
      personBlockedUserIds: ['owner-user'],
    });

    await expect(
      service.send('drama-bar', 'customer-user', { body: 'A question here.' }),
    ).resolves.toMatchObject({ conversationId: MAILBOX_THREAD });
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  // Fix round 1 (c1): with the owner the only staff member and blocked
  // either way, the enquiry would reach nobody, so it is refused with the
  // identity block's code and sentence.
  it('refuses as blocked when the only staff member is person-blocked with the member', async () => {
    const { service, transaction, enquiries } = makeRouting({
      personBlockedUserIds: ['owner-user'],
    });

    await expect(
      service.getContact('drama-bar', 'customer-user'),
    ).resolves.toMatchObject({
      canMessageOwner: false,
      unavailableReason: 'unavailable',
    });
    await expect(
      service.send('drama-bar', 'customer-user', { body: 'A question here.' }),
    ).rejects.toMatchObject({
      response: {
        code: 'IDENTITY_BLOCKED',
        message: 'You cannot contact this business',
      },
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(enquiries.save).not.toHaveBeenCalled();
  });

  /**
   * Ownerless and suspended-owner listings keep working as a business
   * mailbox while an active co-manager can answer them, which is how
   * persona and company mailboxes already decide it: from the staff.
   */
  it('delivers an enquiry to an ownerless listing into the mailbox its co-manager answers', async () => {
    const { service, savedSeats, postMessage, enquiries } = makeRouting({
      ownerUserId: null,
      coManagerUserIds: ['comanager-user'],
    });

    await expect(
      service.getContact('drama-bar', 'customer-user'),
    ).resolves.toMatchObject({
      canMessageOwner: true,
      unavailableReason: null,
    });
    await expect(
      service.send('drama-bar', 'customer-user', { body: 'A question here.' }),
    ).resolves.toMatchObject({ conversationId: MAILBOX_THREAD });

    expect(savedSeats.map((seat) => [seat.userId, seat.identityId])).toEqual([
      ['customer-user', 'profile-customer-user'],
      ['comanager-user', LISTING_IDENTITY],
    ]);
    expect(postMessage).toHaveBeenCalledWith(
      MAILBOX_THREAD,
      'customer-user',
      expect.stringContaining('A question here.'),
    );
    expect(enquiries.save).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: null,
        conversationId: MAILBOX_THREAD,
      }),
    );
  });

  /**
   * The suspended owner keeps a staff seat, as any suspended persona or
   * company staff member does, and is reached through none of it: the
   * suspension signed them out everywhere, which removed every push
   * subscription (`PushService.handleSessionRevoked`) and closes the socket
   * handshake to a non-active account. The co-manager's seat is the one
   * that answers.
   */
  it('delivers an enquiry while the owner is suspended and a co-manager is active', async () => {
    const { service, savedSeats, postMessage, enquiries } = makeRouting({
      coManagerUserIds: ['comanager-user'],
      suspendedUserIds: ['owner-user'],
    });

    await expect(
      service.send('drama-bar', 'customer-user', { body: 'A question here.' }),
    ).resolves.toMatchObject({ conversationId: MAILBOX_THREAD });

    expect(savedSeats.map((seat) => [seat.userId, seat.identityId])).toEqual(
      expect.arrayContaining([['comanager-user', LISTING_IDENTITY]]),
    );
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(enquiries.save).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'owner-user' }),
    );
  });

  it('refuses an ownerless listing nobody manages, with the existing code, and opens no thread', async () => {
    const { service, transaction, postMessage, enquiries } = makeRouting({
      ownerUserId: null,
    });

    await expect(
      service.getContact('drama-bar', 'customer-user'),
    ).resolves.toMatchObject({
      canMessageOwner: false,
      unavailableReason: 'no_owner_account',
    });
    await expect(
      service.send('drama-bar', 'customer-user', { body: 'A question here.' }),
    ).rejects.toThrow(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    expect(enquiries.save).not.toHaveBeenCalled();
  });

  it('refuses when the suspended owner is the only staff member, and opens no thread', async () => {
    const { service, transaction, postMessage } = makeRouting({
      suspendedUserIds: ['owner-user'],
    });

    await expect(
      service.getContact('drama-bar', 'customer-user'),
    ).resolves.toMatchObject({
      canMessageOwner: false,
      unavailableReason: 'no_owner_account',
    });
    await expect(
      service.send('drama-bar', 'customer-user', { body: 'A question here.' }),
    ).rejects.toThrow(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  /**
   * Fix round 1: a staff member who can receive but is blocked with the
   * member, beside one who is not blocked but cannot receive, leaves nobody
   * to read the enquiry. Messaging refuses it with the identity block, in
   * both directions, and nothing is opened or recorded.
   */
  it('refuses a suspended owner beside an active co-manager blocked with the member', async () => {
    const { service, transaction, postMessage, enquiries } = makeRouting({
      coManagerUserIds: ['comanager-user'],
      suspendedUserIds: ['owner-user'],
      personBlockedUserIds: ['comanager-user'],
    });

    await expect(
      service.getContact('drama-bar', 'customer-user'),
    ).resolves.toMatchObject({
      canMessageOwner: false,
      unavailableReason: 'unavailable',
    });
    await expect(
      service.send('drama-bar', 'customer-user', { body: 'A question here.' }),
    ).rejects.toMatchObject({
      response: {
        code: 'IDENTITY_BLOCKED',
        message: 'You cannot contact this business',
      },
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    expect(enquiries.save).not.toHaveBeenCalled();
  });

  it('refuses an active owner blocked with the member beside a suspended co-manager', async () => {
    const { service, transaction, postMessage, enquiries } = makeRouting({
      coManagerUserIds: ['comanager-user'],
      suspendedUserIds: ['comanager-user'],
      personBlockedUserIds: ['owner-user'],
    });

    await expect(
      service.getContact('drama-bar', 'customer-user'),
    ).resolves.toMatchObject({
      canMessageOwner: false,
      unavailableReason: 'unavailable',
    });
    await expect(
      service.send('drama-bar', 'customer-user', { body: 'A question here.' }),
    ).rejects.toMatchObject({ response: { code: 'IDENTITY_BLOCKED' } });
    expect(transaction).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    expect(enquiries.save).not.toHaveBeenCalled();
  });

  it('tells a co-manager it is their own listing, as the owner is told', async () => {
    const { service, transaction } = makeRouting({
      coManagerUserIds: ['comanager-user'],
    });

    await expect(
      service.getContact('drama-bar', 'comanager-user'),
    ).resolves.toMatchObject({
      canMessageOwner: false,
      unavailableReason: 'own_listing',
    });
    await expect(
      service.send('drama-bar', 'comanager-user', { body: 'A question here.' }),
    ).rejects.toThrow(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('points the contact read at the mailbox thread once there is one', async () => {
    const { service } = makeRouting();

    await service.send('drama-bar', 'customer-user', {
      body: 'Is the upstairs room step-free?',
    });

    await expect(
      service.getContact('drama-bar', 'customer-user'),
    ).resolves.toMatchObject({
      canMessageOwner: true,
      existingConversationId: MAILBOX_THREAD,
      followUpAwaitsReply: true,
    });
  });

  /**
   * Task 8's reply-only guard, reached by a real request: a member who staffs
   * another listing, with that listing selected in the mailbox switcher,
   * sends a directory enquiry. `assertInitiatorIsProfile` refuses it before
   * any thread or message exists.
   */
  it('refuses a member acting as a business with IDENTITY_CANNOT_INITIATE', async () => {
    const { service, transaction, postMessage, enquiries } = makeRouting({
      staffIdentityIds: { 'their-own-listing-identity': ['customer-user'] },
    });

    await expect(
      service.send('drama-bar', 'customer-user', {
        body: 'A question here.',
        asIdentityId: 'their-own-listing-identity',
      }),
    ).rejects.toMatchObject({
      response: { code: 'IDENTITY_CANNOT_INITIATE' },
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    expect(enquiries.save).not.toHaveBeenCalled();
  });
});
