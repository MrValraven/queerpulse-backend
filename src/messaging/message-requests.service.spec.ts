import { FindOperator, IsNull } from 'typeorm';
import { recipientNotAcceptingRequestsException } from '../connections/request-limits';
import { MessageRequestsService } from './message-requests.service';

/**
 * PRD-340: reply-implies-accept, the messaging half. `ConnectionsService`
 * (see `connections.service.spec.ts`'s `respondWithReply` block) owns every
 * permission guard; this file covers the other half of the contract: that
 * `handleConnectionAccepted` posts an attached `replyBody` right after the
 * intro message it may seed, in one sequential chain, and stays a no-op for
 * every plain accept that carries no `replyBody` at all.
 */
describe('MessageRequestsService.handleConnectionAccepted (PRD-340)', () => {
  let service: MessageRequestsService;
  let core: {
    getOrCreateConversation: jest.Mock;
    postMessage: jest.Mock;
  };

  beforeEach(() => {
    core = {
      getOrCreateConversation: jest.fn(),
      postMessage: jest.fn().mockResolvedValue({ view: {} }),
    };
    service = new MessageRequestsService(
      {} as never, // profiles repository, unused by this listener
      core as never,
      {} as never, // ConnectionsService, unused by this listener
      {} as never, // BlockFilterService, unused by this listener
      {} as never, // IdentityMailboxSyncService, unused by this listener
      {} as never, // users repository, unused by this listener
      {} as never, // MessagesService, unused by this listener
    );
  });

  it('a plain accept (no replyBody) seeds only the intro message', async () => {
    core.getOrCreateConversation.mockResolvedValue({
      conversation: { id: 'conv1' },
      created: true,
    });
    await service.handleConnectionAccepted({
      connectionId: 'c1',
      requesterId: 'requester',
      addresseeId: 'addressee',
      requestMessage: 'hi, would love to connect',
    });
    expect(core.postMessage).toHaveBeenCalledTimes(1);
    expect(core.postMessage).toHaveBeenCalledWith(
      'conv1',
      'requester',
      'hi, would love to connect',
    );
  });

  it('reply-implies-accept posts the intro THEN the reply, in that order, in one sequential chain', async () => {
    core.getOrCreateConversation.mockResolvedValue({
      conversation: { id: 'conv1' },
      created: true,
    });
    await service.handleConnectionAccepted({
      connectionId: 'c1',
      requesterId: 'requester',
      addresseeId: 'addressee',
      requestMessage: 'hi, would love to connect',
      replyBody: 'Hey! Good to hear from you.',
    });
    expect(core.postMessage).toHaveBeenCalledTimes(2);
    // Order matters: the request the reply answers must exist first.
    expect(core.postMessage).toHaveBeenNthCalledWith(
      1,
      'conv1',
      'requester',
      'hi, would love to connect',
    );
    expect(core.postMessage).toHaveBeenNthCalledWith(
      2,
      'conv1',
      'addressee',
      'Hey! Good to hear from you.',
    );
  });

  it('posts the reply even when the thread already existed (no intro to seed)', async () => {
    // A re-opened (declined, then re-asked) request can be accepted-by-reply
    // against a conversation that already materialized from a PRIOR accept.
    // `created` is false, so there is no intro to seed, but the reply itself
    // must still land.
    core.getOrCreateConversation.mockResolvedValue({
      conversation: { id: 'conv1' },
      created: false,
    });
    await service.handleConnectionAccepted({
      connectionId: 'c1',
      requesterId: 'requester',
      addresseeId: 'addressee',
      requestMessage: 'hi again',
      replyBody: 'Hey! Good to hear from you.',
    });
    expect(core.postMessage).toHaveBeenCalledTimes(1);
    expect(core.postMessage).toHaveBeenCalledWith(
      'conv1',
      'addressee',
      'Hey! Good to hear from you.',
    );
  });

  it('never posts an empty/whitespace reply', async () => {
    core.getOrCreateConversation.mockResolvedValue({
      conversation: { id: 'conv1' },
      created: false,
    });
    await service.handleConnectionAccepted({
      connectionId: 'c1',
      requesterId: 'requester',
      addresseeId: 'addressee',
      requestMessage: null,
      replyBody: '',
    });
    expect(core.postMessage).not.toHaveBeenCalled();
  });
});

/**
 * ENG-407: the connected branch of `messageRequest` ("Say hello" to a member
 * you are already connected with) posts through the ordinary member send path,
 * `MessagesService.sendMessageWithOutcome`, carrying the caller's
 * `clientMessageId`. That path dedups on `(conversationId, clientMessageId)`
 * and runs the `@`-mention fan-out, so a timed-out request the member retries
 * lands one message in the DM, and a mention in it notifies.
 */
describe('MessageRequestsService.messageRequest connected branch (ENG-407)', () => {
  const clientMessageId = '5f0c2a8e-3b1d-4c6f-9a7e-2d4b6c8e0f12';
  const storedMessage = { id: 'm-stored', conversationId: 'conv1', body: 'hi' };
  let service: MessageRequestsService;
  let core: {
    getOrCreateConversation: jest.Mock;
    postMessage: jest.Mock;
  };
  let connections: { areConnected: jest.Mock; requestConnection: jest.Mock };
  let messagesService: { sendMessageWithOutcome: jest.Mock };

  beforeEach(() => {
    core = {
      getOrCreateConversation: jest.fn().mockResolvedValue({
        conversation: { id: 'conv1' },
        created: false,
      }),
      postMessage: jest.fn(),
    };
    connections = {
      areConnected: jest.fn().mockResolvedValue(true),
      requestConnection: jest.fn(),
    };
    // The real send path stores the first write and answers every replay of
    // the same key with that stored row, flagged `isNew: false`.
    messagesService = {
      sendMessageWithOutcome: jest
        .fn()
        .mockResolvedValueOnce({ response: storedMessage, isNew: true })
        .mockResolvedValue({ response: storedMessage, isNew: false }),
    };
    service = new MessageRequestsService(
      {
        findOne: jest.fn().mockResolvedValue({ userId: 'them', slug: 'them' }),
      } as never,
      core as never,
      connections as never,
      { isBlockedEitherWay: jest.fn().mockResolvedValue(false) } as never,
      {} as never, // IdentityMailboxSyncService, unused by this branch
      {
        findOne: jest.fn().mockResolvedValue({ id: 'them', status: 'active' }),
      } as never, // users repository: the recipient is an active member
      messagesService as never,
      // SEC-19: the pair has no block, hide or takedown.
      { exist: jest.fn().mockResolvedValue(false) } as never,
      { isHiddenFrom: jest.fn().mockResolvedValue(false) } as never,
      { statesFor: jest.fn().mockResolvedValue(new Map()) } as never,
    );
  });

  it('sends through the member send path with the caller clientMessageId', async () => {
    const result = await service.messageRequest(
      'me',
      'them',
      'hi',
      clientMessageId,
    );

    expect(messagesService.sendMessageWithOutcome).toHaveBeenCalledWith(
      'conv1',
      'me',
      'hi',
      undefined,
      clientMessageId,
    );
    // The bare core write skips the mention fan-out and the send gates.
    expect(core.postMessage).not.toHaveBeenCalled();
    expect(result).toEqual({
      conversationId: 'conv1',
      message: storedMessage,
      connectionRequestId: null,
    });
  });

  it('a retried request with the same clientMessageId returns the stored message', async () => {
    const first = await service.messageRequest(
      'me',
      'them',
      'hi',
      clientMessageId,
    );
    const replay = await service.messageRequest(
      'me',
      'them',
      'hi',
      clientMessageId,
    );

    expect(replay.message?.id).toBe(first.message?.id);
    expect(replay.conversationId).toBe(first.conversationId);
    expect(messagesService.sendMessageWithOutcome).toHaveBeenCalledTimes(2);
    for (const callNumber of [1, 2]) {
      expect(messagesService.sendMessageWithOutcome).toHaveBeenNthCalledWith(
        callNumber,
        'conv1',
        'me',
        'hi',
        undefined,
        clientMessageId,
      );
    }
    expect(core.postMessage).not.toHaveBeenCalled();
  });

  it('the unconnected branch seeds a connection request and sends no message', async () => {
    connections.areConnected.mockResolvedValue(false);
    connections.requestConnection.mockResolvedValue({ id: 'conn-1' });

    const result = await service.messageRequest(
      'me',
      'them',
      'hi',
      clientMessageId,
    );

    expect(result.connectionRequestId).toBe('conn-1');
    expect(result.message).toBeNull();
    expect(messagesService.sendMessageWithOutcome).not.toHaveBeenCalled();
  });
});

/**
 * LOC-F1: the housing enquiry path asks `enquiryContactability` first and
 * answers a blocked pair with the housing detail read's 404, before the pledge
 * and step-up. That relies on this method naming a block either way as
 * `blocked`. Every other `deliverEnquiry` caller keeps the 403.
 */
describe('MessageRequestsService enquiry block contract (LOC-F1)', () => {
  let service: MessageRequestsService;
  let blockFilter: { isBlockedEitherWay: jest.Mock };
  // SEC-19: whether the sender placed the block themselves.
  let blocks: { exist: jest.Mock };
  let connections: {
    areConnected: jest.Mock;
    assertRequestsNotPaused: jest.Mock;
  };
  let core: { getOrCreateConversation: jest.Mock; postMessage: jest.Mock };

  beforeEach(() => {
    blockFilter = { isBlockedEitherWay: jest.fn().mockResolvedValue(true) };
    blocks = { exist: jest.fn().mockResolvedValue(false) };
    connections = {
      areConnected: jest.fn().mockResolvedValue(false),
      assertRequestsNotPaused: jest.fn().mockResolvedValue(undefined),
    };
    core = {
      getOrCreateConversation: jest.fn(),
      postMessage: jest.fn(),
    };
    service = new MessageRequestsService(
      {} as never, // profiles repository, unused by these paths
      core as never,
      connections as never,
      blockFilter as never,
      {} as never, // IdentityMailboxSyncService, unused by these paths
      {} as never, // users repository, unused by these paths
      {} as never, // MessagesService, unused by these paths
      blocks as never,
    );
  });

  it('names a block either way as blocked so a domain can answer it its own way', async () => {
    const result = await service.enquiryContactability('me', 'them');

    expect(blockFilter.isBlockedEitherWay).toHaveBeenCalledWith('me', 'them');
    expect(result).toEqual({
      canDeliver: false,
      blockedReason: 'blocked',
      replyRequiresConnection: false,
      followUpAwaitsReply: false,
    });
  });

  it('answers deliverEnquiry with the profile read 404 for a block the recipient placed', async () => {
    await expect(
      service.deliverEnquiry('me', 'them', 'hi'),
    ).rejects.toMatchObject({
      status: 404,
      response: { message: 'Member not found' },
    });
    expect(blocks.exist).toHaveBeenCalledWith({
      where: {
        blockerId: 'me',
        blockedId: 'them',
        matchedConversationId: IsNull(),
      },
    });
    expect(core.getOrCreateConversation).not.toHaveBeenCalled();
    expect(core.postMessage).not.toHaveBeenCalled();
  });

  it('answers deliverEnquiry with the 404 for a sender block placed inside a matched chat', async () => {
    // PRD-423: the read leaves matched chat blocks out, so a sender whose only
    // block is a matched chat one reads no block of their own.
    blocks.exist.mockImplementation(
      (options: { where: { matchedConversationId?: unknown } }) =>
        Promise.resolve(
          !(options.where.matchedConversationId instanceof FindOperator),
        ),
    );

    await expect(
      service.deliverEnquiry('me', 'them', 'hi'),
    ).rejects.toMatchObject({ status: 404 });
    expect(core.postMessage).not.toHaveBeenCalled();
  });

  it("names the sender's own block on deliverEnquiry with its code", async () => {
    blocks.exist.mockResolvedValue(true);

    await expect(
      service.deliverEnquiry('me', 'them', 'hi'),
    ).rejects.toMatchObject({
      status: 409,
      response: {
        code: 'UNBLOCK_TO_CONTACT',
        message: 'Unblock this member before sending a request',
      },
    });
    expect(core.postMessage).not.toHaveBeenCalled();
  });
});

/**
 * SEC-02: an unlinked persona's mailbox answers a member who is blocked with
 * every owner exactly as it answers anyone, so the mailbox cannot test who
 * runs the pseudonym. The member's own block of the persona still refuses.
 */
describe('MessageRequestsService.identityEnquiryContactability on an unlinked persona (SEC-02)', () => {
  interface StaffUserRow {
    id: string;
    isSystem: boolean;
    status: string;
  }
  let service: MessageRequestsService;
  let identityBlockKind: 'direct' | 'carried' | null;
  let isUnlinkedPersonaMailbox: boolean;
  let suspendedUserIds: string[];
  let usersQuery: jest.Mock<Promise<unknown[]>, [string, unknown[]]>;
  const staffUserIds = ['owner-user', 'coowner-user'];

  beforeEach(() => {
    identityBlockKind = null;
    isUnlinkedPersonaMailbox = true;
    suspendedUserIds = [];
    usersQuery = jest.fn<Promise<unknown[]>, [string, unknown[]]>(() =>
      Promise.resolve(isUnlinkedPersonaMailbox ? [{ matched: 1 }] : []),
    );
    const blockFilter = {
      identityBlockKind: jest.fn(() => Promise.resolve(identityBlockKind)),
      // The member is person-blocked with every owner.
      blockedUserIds: jest.fn((_userId: string, candidates: string[]) =>
        Promise.resolve(new Set(candidates)),
      ),
    };
    const core = {
      evaluateIdentityContact: jest.fn(() =>
        Promise.resolve({ refusal: null, staffUserIds }),
      ),
      findIdentityConversation: jest.fn(() => Promise.resolve(null)),
    };
    const users = {
      find: jest.fn((): Promise<StaffUserRow[]> =>
        Promise.resolve(
          staffUserIds.map((staffUserId) => ({
            id: staffUserId,
            isSystem: false,
            status: suspendedUserIds.includes(staffUserId)
              ? 'suspended'
              : 'active',
          })),
        ),
      ),
      manager: { query: usersQuery },
    };
    service = new MessageRequestsService(
      {} as never, // profiles repository, unused by this path
      core as never,
      {} as never, // ConnectionsService, unused by this path
      blockFilter as never,
      {} as never, // IdentityMailboxSyncService, unused by this path
      users as never,
      {} as never, // MessagesService, unused by this path
    );
  });

  it('delivers to an unlinked persona whose every owner is blocked with the member', async () => {
    await expect(
      service.identityEnquiryContactability('member-user', 'persona-identity'),
    ).resolves.toMatchObject({ canDeliver: true, blockedReason: null });
    expect(usersQuery.mock.calls[0]?.[1]).toEqual([
      'persona-identity',
      'subprofile',
      'unlinked',
    ]);
  });

  it('still refuses the same mailbox as blocked when nobody can receive at all', async () => {
    suspendedUserIds = [...staffUserIds];

    await expect(
      service.identityEnquiryContactability('member-user', 'persona-identity'),
    ).resolves.toMatchObject({ canDeliver: false, blockedReason: 'blocked' });
  });

  it("keeps the member's own block of the persona as a refusal", async () => {
    identityBlockKind = 'direct';

    await expect(
      service.identityEnquiryContactability('member-user', 'persona-identity'),
    ).resolves.toMatchObject({ canDeliver: false, blockedReason: 'blocked' });
    expect(usersQuery).not.toHaveBeenCalled();
  });

  it('keeps refusing any other mailbox whose every staff member is blocked', async () => {
    isUnlinkedPersonaMailbox = false;

    await expect(
      service.identityEnquiryContactability('member-user', 'listing-identity'),
    ).resolves.toMatchObject({ canDeliver: false, blockedReason: 'blocked' });
  });
});

/**
 * SEC-19: the first-contact refusals of `messageRequest` tell a requester
 * nothing their profile page does not. The requester's own block is named
 * first, with its code. Every recipient the profile read answers 404 for (an
 * inactive account, a block the recipient placed, a hide from this
 * requester, a live self-hide, a moderator takedown) answers the same 404,
 * so a blocked requester reads a member who accepts nobody's requests the
 * way an unknown handle reads, and every requester who can see them gets the
 * gate's coded 403.
 */
describe('MessageRequestsService.messageRequest refusals (SEC-19)', () => {
  interface RequestScenario {
    recipientStatus: string;
    hasRequesterBlocked: boolean;
    // PRD-423: the requester's block was placed inside a matched chat.
    isRequesterBlockMatched: boolean;
    isBlockedEitherWay: boolean;
    isHiddenFromRequester: boolean;
    recipientHiddenUntil: Date | null;
    takenDownSubjectId: string | null;
  }
  interface TakedownState {
    hidden: boolean;
    removed: boolean;
  }
  interface RequestDoubles {
    connections: { areConnected: jest.Mock; requestConnection: jest.Mock };
    blocks: { exist: jest.Mock };
  }

  interface BlockExistOptions {
    where: { matchedConversationId?: unknown };
  }

  const RECIPIENT_USER_ID = 'them-user';
  const RECIPIENT_SLUG = 'them';

  /** Whether the requester's block row passes the read's filter: a matched
   *  chat block passes only a read that leaves out its `IsNull` filter. */
  function blockRowMatches(
    state: RequestScenario,
    options: BlockExistOptions,
  ): boolean {
    const filtersOutMatchedBlocks =
      options.where.matchedConversationId instanceof FindOperator &&
      options.where.matchedConversationId.type === 'isNull';
    return (
      state.hasRequesterBlocked &&
      !(state.isRequesterBlockMatched && filtersOutMatchedBlocks)
    );
  }

  function scenario(overrides: Partial<RequestScenario>): RequestScenario {
    return {
      recipientStatus: 'active',
      hasRequesterBlocked: false,
      isRequesterBlockMatched: false,
      isBlockedEitherWay: false,
      isHiddenFromRequester: false,
      recipientHiddenUntil: null,
      takenDownSubjectId: null,
      ...overrides,
    };
  }

  function buildService(state: RequestScenario): {
    service: MessageRequestsService;
    doubles: RequestDoubles;
  } {
    const takedownStates = new Map<string, TakedownState>();
    if (state.takenDownSubjectId) {
      takedownStates.set(state.takenDownSubjectId, {
        hidden: true,
        removed: false,
      });
    }
    const doubles: RequestDoubles = {
      connections: {
        areConnected: jest.fn().mockResolvedValue(false),
        requestConnection: jest.fn().mockResolvedValue({ id: 'conn-1' }),
      },
      blocks: {
        exist: jest.fn((options: BlockExistOptions) =>
          Promise.resolve(blockRowMatches(state, options)),
        ),
      },
    };
    const service = new MessageRequestsService(
      {
        findOne: jest.fn().mockResolvedValue({
          userId: RECIPIENT_USER_ID,
          slug: RECIPIENT_SLUG,
          hiddenUntil: state.recipientHiddenUntil,
        }),
      } as never,
      {} as never,
      doubles.connections as never,
      {
        isBlockedEitherWay: jest
          .fn()
          .mockResolvedValue(
            state.isBlockedEitherWay || state.hasRequesterBlocked,
          ),
      } as never,
      {} as never,
      {
        findOne: jest.fn().mockResolvedValue({
          id: RECIPIENT_USER_ID,
          status: state.recipientStatus,
        }),
      } as never,
      {} as never,
      doubles.blocks as never,
      {
        isHiddenFrom: jest.fn().mockResolvedValue(state.isHiddenFromRequester),
      } as never,
      { statesFor: jest.fn().mockResolvedValue(takedownStates) } as never,
    );
    return { service, doubles };
  }

  it("names the requester's own block with its code", async () => {
    const { service, doubles } = buildService(
      scenario({ hasRequesterBlocked: true }),
    );

    await expect(
      service.messageRequest('me', RECIPIENT_SLUG, 'hi'),
    ).rejects.toMatchObject({
      status: 409,
      response: {
        code: 'UNBLOCK_TO_CONTACT',
        message: 'Unblock this member before sending a request',
      },
    });
    expect(doubles.blocks.exist).toHaveBeenCalledWith({
      where: {
        blockerId: 'me',
        blockedId: RECIPIENT_USER_ID,
        matchedConversationId: IsNull(),
      },
    });
    expect(doubles.connections.requestConnection).not.toHaveBeenCalled();
  });

  it("names the requester's own block ahead of the recipient's account status", async () => {
    const { service } = buildService(
      scenario({ hasRequesterBlocked: true, recipientStatus: 'suspended' }),
    );

    await expect(
      service.messageRequest('me', RECIPIENT_SLUG, 'hi'),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'UNBLOCK_TO_CONTACT' },
    });
  });

  it("answers the requester's own block placed inside a matched chat with the profile read 404", async () => {
    const { service, doubles } = buildService(
      scenario({ hasRequesterBlocked: true, isRequesterBlockMatched: true }),
    );

    const refusal = service.messageRequest('me', RECIPIENT_SLUG, 'hi');

    await expect(refusal).rejects.toMatchObject({
      status: 404,
      response: { message: 'Member not found' },
    });
    await expect(refusal).rejects.not.toMatchObject({
      response: { code: 'UNBLOCK_TO_CONTACT' },
    });
    expect(doubles.connections.requestConnection).not.toHaveBeenCalled();
  });

  it.each<[string, Partial<RequestScenario>]>([
    ['an account that is not active', { recipientStatus: 'suspended' }],
    ['a block the recipient placed', { isBlockedEitherWay: true }],
    ['a hide from this requester', { isHiddenFromRequester: true }],
    [
      'a live self-hide',
      { recipientHiddenUntil: new Date(Date.now() + 60 * 60 * 1000) },
    ],
    ['a takedown filed under the slug', { takenDownSubjectId: RECIPIENT_SLUG }],
    [
      'a takedown filed under the user id',
      { takenDownSubjectId: RECIPIENT_USER_ID },
    ],
  ])('answers %s with the profile read 404', async (_label, overrides) => {
    const { service, doubles } = buildService(scenario(overrides));

    await expect(
      service.messageRequest('me', RECIPIENT_SLUG, 'hi'),
    ).rejects.toMatchObject({
      status: 404,
      response: { message: 'Member not found' },
    });
    expect(doubles.connections.areConnected).not.toHaveBeenCalled();
    expect(doubles.connections.requestConnection).not.toHaveBeenCalled();
  });

  it('lets a request through once a self-hide has expired', async () => {
    const { service } = buildService(
      scenario({ recipientHiddenUntil: new Date(Date.now() - 60 * 1000) }),
    );

    await expect(
      service.messageRequest('me', RECIPIENT_SLUG, 'hi'),
    ).resolves.toMatchObject({ connectionRequestId: 'conn-1' });
  });

  it('passes the recipient gate refusal through to a requester the recipient can be seen by', async () => {
    const { service, doubles } = buildService(scenario({}));
    doubles.connections.requestConnection.mockRejectedValue(
      recipientNotAcceptingRequestsException(),
    );

    await expect(
      service.messageRequest('me', RECIPIENT_SLUG, 'hi'),
    ).rejects.toMatchObject({
      status: 403,
      response: { code: 'RECIPIENT_NOT_ACCEPTING_REQUESTS' },
    });
  });

  it('answers a blocked requester the profile read 404 whatever the recipient gate says', async () => {
    const { service, doubles } = buildService(
      scenario({ isBlockedEitherWay: true }),
    );
    doubles.connections.requestConnection.mockRejectedValue(
      recipientNotAcceptingRequestsException(),
    );

    const refusal = service.messageRequest('me', RECIPIENT_SLUG, 'hi');

    await expect(refusal).rejects.toMatchObject({ status: 404 });
    await expect(refusal).rejects.not.toMatchObject({
      response: { message: 'A request is already pending' },
    });
  });
});
