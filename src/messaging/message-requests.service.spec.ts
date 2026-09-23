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
