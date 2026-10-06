import { ForbiddenException } from '@nestjs/common';
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
      {} as never, // users repository, unused by this branch
      messagesService as never,
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
  let connections: {
    areConnected: jest.Mock;
    assertRequestsNotPaused: jest.Mock;
  };
  let core: { getOrCreateConversation: jest.Mock; postMessage: jest.Mock };

  beforeEach(() => {
    blockFilter = { isBlockedEitherWay: jest.fn().mockResolvedValue(true) };
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

  it('keeps the 403 on deliverEnquiry for every other caller', async () => {
    await expect(service.deliverEnquiry('me', 'them', 'hi')).rejects.toThrow(
      new ForbiddenException('You cannot contact this member'),
    );
    expect(core.getOrCreateConversation).not.toHaveBeenCalled();
    expect(core.postMessage).not.toHaveBeenCalled();
  });
});
