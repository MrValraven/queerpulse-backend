import { ForbiddenException } from '@nestjs/common';
import { IdentityKind } from '../identities/entities/identity.entity';
import { UserStatus } from '../users/entities/user.entity';
import { MessageRequestsService } from './message-requests.service';
import { MessagingCoreService } from './messaging-core.service';

/**
 * Task 18: `MessageRequestsService.deliverEnquiryToIdentity` and its
 * read-only twin, run through the real `MessagingCoreService` thread logic
 * with storage, identities and the cross-domain services stubbed. Each test
 * pins one step the personal `deliverEnquiry` takes and its mailbox form.
 */

interface SavedRow {
  [column: string]: unknown;
}

const BUSINESS = 'business-identity';

function makeChain(
  options: {
    staff?: string[];
    identityBlocked?: boolean;
    personBlockedUserIds?: string[];
    suspendedUserIds?: string[];
    existingConversations?: SavedRow[];
  } = {},
) {
  const staff = options.staff ?? ['owner-user', 'comanager-user'];
  const savedConversations: SavedRow[] = [
    ...(options.existingConversations ?? []),
  ];
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
    staffUserIds: jest.fn(() => Promise.resolve(staff)),
    isRemovedPersona: jest.fn(() => Promise.resolve(false)),
    assertMayActAs: jest.fn(() => Promise.resolve()),
  };
  const conversations = {
    findOne: jest.fn(({ where }: { where: { pairKey: string } }) =>
      Promise.resolve(
        savedConversations.find(
          (conversation) => conversation.pairKey === where.pairKey,
        ) ?? null,
      ),
    ),
    update: jest.fn(() => Promise.resolve()),
  };
  const transaction = jest.fn((run: (manager: unknown) => Promise<unknown>) =>
    run({
      create: (_entity: unknown, row: SavedRow) => ({ ...row }),
      save: (rows: SavedRow | SavedRow[]) => {
        if (Array.isArray(rows)) {
          savedSeats.push(...rows);
          return Promise.resolve(rows);
        }
        const conversation = { ...rows, id: 'new-conversation' };
        savedConversations.push(conversation);
        return Promise.resolve(conversation);
      },
    }),
  );
  const postMessage = jest.fn(() =>
    Promise.resolve({ view: {}, response: {}, isNew: true }),
  );
  const core = Object.create(
    MessagingCoreService.prototype,
  ) as MessagingCoreService;
  Object.assign(core, {
    identities,
    conversations,
    dataSource: { transaction },
    postMessage,
  });
  const blockFilter = {
    isIdentityBlocked: jest.fn(() =>
      Promise.resolve(Boolean(options.identityBlocked)),
    ),
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
  const connections = {
    areConnected: jest.fn(() => Promise.resolve(true)),
    assertRequestsNotPaused: jest.fn(() => Promise.resolve()),
  };
  const mailboxSync = {
    resyncMailbox: jest.fn(() => Promise.resolve([])),
    resyncConversation: jest.fn(() => Promise.resolve([])),
  };
  // Every staff member's account, active unless the test suspends it.
  const users = {
    find: jest.fn(() =>
      Promise.resolve(
        staff.map((staffUserId) => ({
          id: staffUserId,
          isSystem: false,
          status: (options.suspendedUserIds ?? []).includes(staffUserId)
            ? UserStatus.Suspended
            : UserStatus.Active,
        })),
      ),
    ),
  };
  const service = new MessageRequestsService(
    {} as never,
    core,
    connections as never,
    blockFilter as never,
    mailboxSync as never,
    users as never,
  );
  return {
    service,
    savedConversations,
    savedSeats,
    postMessage,
    transaction,
    blockFilter,
    connections,
    mailboxSync,
  };
}

const existingPairKey = ['profile-customer-user', BUSINESS].sort().join(':');

describe('deliverEnquiryToIdentity', () => {
  it('opens the mailbox thread and posts the member’s words into it as the member', async () => {
    const { service, savedConversations, postMessage } = makeChain();

    const result = await service.deliverEnquiryToIdentity(
      'customer-user',
      BUSINESS,
      'Is the upstairs room step-free?',
    );

    expect(result).toEqual({ conversationId: 'new-conversation' });
    expect(savedConversations[0]).toMatchObject({
      pairKey: existingPairKey,
      initiatorUserId: 'customer-user',
    });
    expect(postMessage).toHaveBeenCalledWith(
      'new-conversation',
      'customer-user',
      'Is the upstairs room step-free?',
    );
  });

  it('refuses the member’s block of the identity in the shape a person block is refused, and opens nothing', async () => {
    const { service, transaction, postMessage } = makeChain({
      identityBlocked: true,
    });

    const refusal = service.deliverEnquiryToIdentity(
      'customer-user',
      BUSINESS,
      'A question here.',
    );

    await expect(refusal).rejects.toThrow(
      new ForbiddenException('You cannot contact this business'),
    );
    // Fix round 1 (c4): a stable code for the frontend.
    await expect(refusal).rejects.toMatchObject({
      response: { code: 'IDENTITY_BLOCKED' },
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('does not refuse a person block with one staff member, and seats that person like every colleague', async () => {
    const { service, savedSeats, blockFilter, postMessage } = makeChain({
      personBlockedUserIds: ['comanager-user'],
    });

    await service.deliverEnquiryToIdentity(
      'customer-user',
      BUSINESS,
      'A question here.',
    );

    expect(blockFilter.isBlockedEitherWay).not.toHaveBeenCalled();
    expect(savedSeats.map((seat) => seat.userId)).toEqual([
      'customer-user',
      'owner-user',
      'comanager-user',
    ]);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  // Fix round 1 (c1): with every staff member person-blocked either way,
  // the message could reach nobody, so it is refused as an identity block.
  it('refuses as blocked when no staff seat would be reachable, and opens nothing', async () => {
    const { service, transaction, postMessage, blockFilter } = makeChain({
      personBlockedUserIds: ['owner-user', 'comanager-user'],
    });

    await expect(
      service.deliverEnquiryToIdentity(
        'customer-user',
        BUSINESS,
        'A question here.',
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'IDENTITY_BLOCKED',
        message: 'You cannot contact this business',
      },
    });
    expect(blockFilter.blockedUserIds).toHaveBeenCalledWith('customer-user', [
      'owner-user',
      'comanager-user',
    ]);
    expect(transaction).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  /**
   * Fix round 1: reachable means one and the same staff member is both
   * unblocked with the member and behind an account that can receive. A
   * suspended colleague who is not blocked and an active one who is leave
   * nobody to read the message, whichever of the two is which.
   */
  it('refuses when the only active staff member is blocked and the unblocked one is suspended', async () => {
    const { service, transaction, postMessage } = makeChain({
      suspendedUserIds: ['owner-user'],
      personBlockedUserIds: ['comanager-user'],
    });

    await expect(
      service.deliverEnquiryToIdentity(
        'customer-user',
        BUSINESS,
        'A question here.',
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'IDENTITY_BLOCKED',
        message: 'You cannot contact this business',
      },
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('refuses the mirror case too: the blocked one is active and the unblocked one is suspended', async () => {
    const { service, transaction, postMessage } = makeChain({
      suspendedUserIds: ['comanager-user'],
      personBlockedUserIds: ['owner-user'],
    });

    await expect(
      service.deliverEnquiryToIdentity(
        'customer-user',
        BUSINESS,
        'A question here.',
      ),
    ).rejects.toMatchObject({ response: { code: 'IDENTITY_BLOCKED' } });
    expect(transaction).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('refuses when every staff member is suspended, with nobody blocked', async () => {
    const { service, transaction } = makeChain({
      suspendedUserIds: ['owner-user', 'comanager-user'],
    });

    await expect(
      service.deliverEnquiryToIdentity(
        'customer-user',
        BUSINESS,
        'A question here.',
      ),
    ).rejects.toMatchObject({ response: { code: 'IDENTITY_BLOCKED' } });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('delivers while one staff member is both unblocked and active', async () => {
    const { service, postMessage } = makeChain({
      suspendedUserIds: ['owner-user'],
    });

    await expect(
      service.deliverEnquiryToIdentity(
        'customer-user',
        BUSINESS,
        'A question here.',
      ),
    ).resolves.toEqual({ conversationId: 'new-conversation' });
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it('refuses a reused thread too once nobody behind it is reachable', async () => {
    const { service, postMessage } = makeChain({
      staff: ['owner-user'],
      personBlockedUserIds: ['owner-user'],
      existingConversations: [
        {
          id: 'existing-conversation',
          pairKey: existingPairKey,
          initiatorUserId: 'customer-user',
          openedAt: null,
        },
      ],
    });

    await expect(
      service.deliverEnquiryToIdentity(
        'customer-user',
        BUSINESS,
        'A follow-up question.',
      ),
    ).rejects.toMatchObject({ response: { code: 'IDENTITY_BLOCKED' } });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('meets the report-driven pause even between connected members, since connection never reaches a mailbox', async () => {
    const { service, connections, transaction } = makeChain();
    connections.assertRequestsNotPaused.mockRejectedValueOnce(
      new ForbiddenException({ code: 'CONNECTION_REQUESTS_PAUSED' }),
    );

    await expect(
      service.deliverEnquiryToIdentity(
        'customer-user',
        BUSINESS,
        'A question here.',
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(connections.assertRequestsNotPaused).toHaveBeenCalledWith(
      'customer-user',
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it('seats the current staff on a reused thread, and posts into that same thread', async () => {
    const { service, mailboxSync, transaction, postMessage } = makeChain({
      existingConversations: [
        {
          id: 'existing-conversation',
          pairKey: existingPairKey,
          initiatorUserId: 'customer-user',
          openedAt: null,
        },
      ],
    });

    const result = await service.deliverEnquiryToIdentity(
      'customer-user',
      BUSINESS,
      'A follow-up question.',
    );

    expect(result).toEqual({ conversationId: 'existing-conversation' });
    expect(transaction).not.toHaveBeenCalled();
    // Fix round 1: this one thread, and never the whole mailbox. Final
    // review C, I1: under the staff source lock, in the resync's own
    // transaction (no caller manager), which emits after it commits.
    expect(mailboxSync.resyncConversation).toHaveBeenCalledWith(
      BUSINESS,
      'existing-conversation',
      undefined,
      { shouldLockStaffSource: true },
    );
    expect(mailboxSync.resyncMailbox).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      'existing-conversation',
      'customer-user',
      'A follow-up question.',
    );
  });

  it('does not resync a thread it has just seated', async () => {
    const { service, mailboxSync } = makeChain();

    await service.deliverEnquiryToIdentity(
      'customer-user',
      BUSINESS,
      'A question here.',
    );

    expect(mailboxSync.resyncConversation).not.toHaveBeenCalled();
  });

  it('carries the refusal code when the mailbox has nobody to answer it', async () => {
    const { service, postMessage } = makeChain({ staff: [] });

    await expect(
      service.deliverEnquiryToIdentity(
        'customer-user',
        BUSINESS,
        'A question here.',
      ),
    ).rejects.toMatchObject({
      response: { code: 'IDENTITY_HAS_NO_STAFF' },
    });
    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe('identityEnquiryContactability', () => {
  it('says follow-ups wait on the first reply when there is no thread yet', async () => {
    const { service } = makeChain();

    await expect(
      service.identityEnquiryContactability('customer-user', BUSINESS),
    ).resolves.toEqual({
      canDeliver: true,
      blockedReason: null,
      replyRequiresConnection: false,
      followUpAwaitsReply: true,
      existingConversationId: null,
    });
  });

  it('points at the existing thread, and stops waiting once the business has replied', async () => {
    const { service } = makeChain({
      existingConversations: [
        {
          id: 'existing-conversation',
          pairKey: existingPairKey,
          initiatorUserId: 'customer-user',
          openedAt: new Date('2026-09-01T10:00:00Z'),
        },
      ],
    });

    await expect(
      service.identityEnquiryContactability('customer-user', BUSINESS),
    ).resolves.toMatchObject({
      canDeliver: true,
      followUpAwaitsReply: false,
      existingConversationId: 'existing-conversation',
    });
  });

  it('reports the member’s block of the identity as blocked', async () => {
    const { service } = makeChain({ identityBlocked: true });

    await expect(
      service.identityEnquiryContactability('customer-user', BUSINESS),
    ).resolves.toMatchObject({ canDeliver: false, blockedReason: 'blocked' });
  });

  it('reports the same refusal code the delivery throws', async () => {
    const { service } = makeChain();

    await expect(
      service.identityEnquiryContactability('owner-user', BUSINESS),
    ).resolves.toMatchObject({
      canDeliver: false,
      blockedReason: 'IDENTITY_IS_YOUR_OWN',
    });
    await expect(
      service.deliverEnquiryToIdentity('owner-user', BUSINESS, 'A question.'),
    ).rejects.toMatchObject({ response: { code: 'IDENTITY_IS_YOUR_OWN' } });
  });

  it('reports no reachable staff as blocked, the same reason as the identity block', async () => {
    const { service } = makeChain({
      personBlockedUserIds: ['owner-user', 'comanager-user'],
    });

    await expect(
      service.identityEnquiryContactability('customer-user', BUSINESS),
    ).resolves.toEqual({
      canDeliver: false,
      blockedReason: 'blocked',
      replyRequiresConnection: false,
      followUpAwaitsReply: false,
      existingConversationId: null,
    });
  });

  it('reports a suspended unblocked colleague beside a blocked active one as blocked', async () => {
    const { service } = makeChain({
      suspendedUserIds: ['owner-user'],
      personBlockedUserIds: ['comanager-user'],
    });

    await expect(
      service.identityEnquiryContactability('customer-user', BUSINESS),
    ).resolves.toMatchObject({ canDeliver: false, blockedReason: 'blocked' });
  });

  it('never reports a person block with one staff member', async () => {
    const { service } = makeChain({ personBlockedUserIds: ['owner-user'] });

    await expect(
      service.identityEnquiryContactability('customer-user', BUSINESS),
    ).resolves.toMatchObject({ canDeliver: true, blockedReason: null });
  });
});
