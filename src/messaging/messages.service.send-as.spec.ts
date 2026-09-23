import { ForbiddenException } from '@nestjs/common';
import { MessageAnnotationsService } from './message-annotations.service';
import { MessageKind } from './entities/message.entity';
import { MessagesService } from './messages.service';
import { MessagingCoreService } from './messaging-core.service';

/**
 * Task 7: the authorization surface for sending (and acting) as an identity.
 * Every write path in messaging must answer two questions before anything is
 * persisted: may this human speak for that identity at all, and does that
 * identity hold a seat in this conversation, both via
 * `MessagingCoreService.assertMaySendAs`. This file covers the guard itself
 * and then one real test per guarded write-path method, each proving the
 * guard runs BEFORE the write: a refusal must leave the database exactly as
 * it was, with the call itself also rejected.
 */

function makeCore(options: {
  isAllowedToActAs: boolean;
  isIdentityInThread: boolean;
}) {
  const core = Object.create(
    MessagingCoreService.prototype,
  ) as MessagingCoreService;
  const identities = {
    assertMayActAs: jest.fn(async () => {
      if (!options.isAllowedToActAs) {
        throw new ForbiddenException({ code: 'IDENTITY_NOT_STAFF' });
      }
    }),
  };
  // CW-05: `assertMaySendAs` now asks the exact seat it needs by
  // `(conversationId, identityId)` through `exist`, an existence check, in
  // place of the earlier `find` over the whole conversation's seats.
  const participants = {
    exist: jest.fn().mockResolvedValue(options.isIdentityInThread),
  };
  Object.assign(core, { identities, participants });
  return { core, identities, participants };
}

describe('MessagingCoreService.assertMaySendAs', () => {
  it('passes when the caller is staff and the identity sits in the thread', async () => {
    const { core, identities, participants } = makeCore({
      isAllowedToActAs: true,
      isIdentityInThread: true,
    });
    await expect(
      core.assertMaySendAs('conversation-1', 'staff-user', 'business-identity'),
    ).resolves.toBeUndefined();
    expect(identities.assertMayActAs).toHaveBeenCalledWith(
      'staff-user',
      'business-identity',
      {},
    );
    // CW-05: pins the narrowed query shape directly, by the exact pair
    // this call needs, so the seat scan does not resurface unnoticed.
    expect(participants.exist).toHaveBeenCalledWith({
      where: {
        conversationId: 'conversation-1',
        identityId: 'business-identity',
      },
    });
  });

  it('rejects a caller who is not staff of the identity', async () => {
    const { core } = makeCore({
      isAllowedToActAs: false,
      isIdentityInThread: true,
    });
    await expect(
      core.assertMaySendAs('conversation-1', 'stranger', 'business-identity'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects an identity the caller may act as but which is absent from the thread', async () => {
    const { core } = makeCore({
      isAllowedToActAs: true,
      isIdentityInThread: false,
    });
    await expect(
      core.assertMaySendAs('conversation-1', 'staff-user', 'business-identity'),
    ).rejects.toThrow(ForbiddenException);
  });

  // CW-28: the guard's own contribution to the moderation-removed-persona
  // delete exception is forwarding `options` on to
  // `IdentitiesService.assertMayActAs` untouched, so the exception it
  // grants lives entirely in one place.
  it('forwards isDeletingOwnMessage through to assertMayActAs', async () => {
    const { core, identities } = makeCore({
      isAllowedToActAs: true,
      isIdentityInThread: true,
    });
    await expect(
      core.assertMaySendAs(
        'conversation-1',
        'staff-user',
        'business-identity',
        { isDeletingOwnMessage: true },
      ),
    ).resolves.toBeUndefined();
    expect(identities.assertMayActAs).toHaveBeenCalledWith(
      'staff-user',
      'business-identity',
      { isDeletingOwnMessage: true },
    );
  });
});

// Write paths: a refused guard must leave the database untouched.
//
// Each test below spies directly on the method under test's own call to the
// guard (`assertMaySendAs`, mocked to reject), reusing the three scenarios
// already proved above. The point of each test is ordering: the guard must
// run BEFORE the write, so every assertion pairs the rejection with proof
// that the write itself never ran. A guard placed AFTER the write would
// still produce the same rejection while leaving the row behind, which is
// exactly the gap this pairing is meant to catch.

describe('MessagingCoreService.postMessage refuses and saves nothing', () => {
  it('rejects an unauthorized identity before any message is created', async () => {
    const messages = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((entity: unknown) => entity),
      save: jest.fn(),
    };
    const identities = {
      resolveProfileIdentityId: jest.fn().mockResolvedValue('profile-identity'),
    };
    const service = Object.create(
      MessagingCoreService.prototype,
    ) as MessagingCoreService;
    Object.assign(service, { messages, identities });
    const assertMaySendAs = jest
      .spyOn(service, 'assertMaySendAs')
      .mockRejectedValue(
        new ForbiddenException({ code: 'IDENTITY_NOT_STAFF' }),
      );

    await expect(
      service.postMessage(
        'conversation-1',
        'stranger',
        'hello',
        undefined,
        undefined,
        undefined,
        'user',
        undefined,
        undefined,
        'business-identity',
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(assertMaySendAs).toHaveBeenCalledWith(
      'conversation-1',
      'stranger',
      'business-identity',
    );
    expect(messages.create).not.toHaveBeenCalled();
    expect(messages.save).not.toHaveBeenCalled();
  });
});

describe('MessagesService.editMessage refuses and saves nothing', () => {
  it('rejects an author who is no longer entitled to act as the message identity', async () => {
    const messages = {
      findOne: jest.fn().mockResolvedValue({
        id: 'message-1',
        conversationId: 'conversation-1',
        senderId: 'staff-user',
        senderIdentityId: 'business-identity',
        kind: MessageKind.User,
        deletedAt: null,
        createdAt: new Date(),
      }),
      save: jest.fn(),
    };
    const core = {
      requireActiveParticipant: jest.fn().mockResolvedValue({}),
      assertMaySendAs: jest
        .fn()
        .mockRejectedValue(
          new ForbiddenException({ code: 'IDENTITY_NOT_STAFF' }),
        ),
      isMessageTakenDown: jest.fn().mockResolvedValue(false),
    };
    const service = Object.create(MessagesService.prototype) as MessagesService;
    Object.assign(service, { messages, core });

    await expect(
      service.editMessage(
        'conversation-1',
        'message-1',
        'staff-user',
        'edited',
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(core.assertMaySendAs).toHaveBeenCalledWith(
      'conversation-1',
      'staff-user',
      'business-identity',
    );
    expect(messages.save).not.toHaveBeenCalled();
  });
});

describe('MessagesService.deleteMessage refuses and saves nothing', () => {
  it('rejects an author who is no longer entitled to act as the message identity', async () => {
    const messages = {
      findOne: jest.fn().mockResolvedValue({
        id: 'message-1',
        conversationId: 'conversation-1',
        senderId: 'staff-user',
        senderIdentityId: 'business-identity',
        kind: MessageKind.User,
        deletedAt: null,
      }),
      createQueryBuilder: jest.fn(),
      manager: { transaction: jest.fn() },
    };
    const core = {
      requireParticipant: jest.fn().mockResolvedValue({}),
      assertMaySendAs: jest
        .fn()
        .mockRejectedValue(
          new ForbiddenException({ code: 'IDENTITY_NOT_STAFF' }),
        ),
    };
    const service = Object.create(MessagesService.prototype) as MessagesService;
    Object.assign(service, { messages, core });

    await expect(
      service.deleteMessage('conversation-1', 'message-1', 'staff-user'),
    ).rejects.toThrow(ForbiddenException);
    // CW-28: the author-delete branch passes `isDeletingOwnMessage`, the
    // one exception the guard carries, and the guard still refuses here
    // because `assertMaySendAs` itself is stubbed to reject regardless.
    expect(core.assertMaySendAs).toHaveBeenCalledWith(
      'conversation-1',
      'staff-user',
      'business-identity',
      { isDeletingOwnMessage: true },
    );
    expect(messages.createQueryBuilder).not.toHaveBeenCalled();
    expect(messages.manager.transaction).not.toHaveBeenCalled();
  });
});

describe('MessagesService.deleteMessage — author deleting their own message', () => {
  it('passes isDeletingOwnMessage so a moderation-removed persona may still delete its own message', async () => {
    const updateQueryBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const messages = {
      findOne: jest.fn().mockResolvedValue({
        id: 'message-1',
        conversationId: 'conversation-1',
        senderId: 'staff-user',
        senderIdentityId: 'business-identity',
        kind: MessageKind.User,
        deletedAt: null,
      }),
      createQueryBuilder: jest.fn(() => updateQueryBuilder),
    };
    const core = {
      requireParticipant: jest.fn().mockResolvedValue({}),
      assertMaySendAs: jest.fn().mockResolvedValue(undefined),
    };
    const eventEmitter = { emit: jest.fn() };
    const service = Object.create(MessagesService.prototype) as MessagesService;
    Object.assign(service, { messages, core, eventEmitter });

    await expect(
      service.deleteMessage('conversation-1', 'message-1', 'staff-user'),
    ).resolves.toEqual({ ok: true });

    // CW-28 ruling: an author deleting their own message is the one write
    // the guard's `isDeletingOwnMessage` exception covers, so a
    // moderation-removed persona keeps this one path.
    expect(core.assertMaySendAs).toHaveBeenCalledWith(
      'conversation-1',
      'staff-user',
      'business-identity',
      { isDeletingOwnMessage: true },
    );
  });
});

describe('MessageAnnotationsService.addMessageReaction refuses and saves nothing', () => {
  it('rejects a seat that is no longer entitled to act as its identity', async () => {
    const reactions = { createQueryBuilder: jest.fn() };
    const core = {
      requireActiveParticipant: jest
        .fn()
        .mockResolvedValue({ identityId: 'business-identity' }),
      assertMaySendAs: jest
        .fn()
        .mockRejectedValue(
          new ForbiddenException({ code: 'IDENTITY_NOT_STAFF' }),
        ),
    };
    const service = Object.create(
      MessageAnnotationsService.prototype,
    ) as MessageAnnotationsService;
    Object.assign(service, { reactions, core });

    await expect(
      service.addMessageReaction(
        'conversation-1',
        'message-1',
        'staff-user',
        'love' as never,
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(core.assertMaySendAs).toHaveBeenCalledWith(
      'conversation-1',
      'staff-user',
      'business-identity',
    );
    expect(reactions.createQueryBuilder).not.toHaveBeenCalled();
  });
});

describe('MessageAnnotationsService.removeMessageReaction refuses and saves nothing', () => {
  it('rejects a seat that is no longer entitled to act as its identity', async () => {
    const reactions = { delete: jest.fn() };
    const core = {
      requireActiveParticipant: jest
        .fn()
        .mockResolvedValue({ identityId: 'business-identity' }),
      assertMaySendAs: jest
        .fn()
        .mockRejectedValue(
          new ForbiddenException({ code: 'IDENTITY_NOT_STAFF' }),
        ),
    };
    const service = Object.create(
      MessageAnnotationsService.prototype,
    ) as MessageAnnotationsService;
    Object.assign(service, { reactions, core });

    await expect(
      service.removeMessageReaction(
        'conversation-1',
        'message-1',
        'staff-user',
        'love' as never,
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(reactions.delete).not.toHaveBeenCalled();
  });
});

describe('MessageAnnotationsService.pinMessage refuses and saves nothing', () => {
  it('rejects a seat that is no longer entitled to act as its identity', async () => {
    const pins = {
      createQueryBuilder: jest.fn(),
      exist: jest.fn(),
      count: jest.fn(),
    };
    const core = {
      requireActiveParticipant: jest
        .fn()
        .mockResolvedValue({ identityId: 'business-identity' }),
      assertMaySendAs: jest
        .fn()
        .mockRejectedValue(
          new ForbiddenException({ code: 'IDENTITY_NOT_STAFF' }),
        ),
    };
    const service = Object.create(
      MessageAnnotationsService.prototype,
    ) as MessageAnnotationsService;
    Object.assign(service, { pins, core });

    await expect(
      service.pinMessage('conversation-1', 'message-1', 'staff-user'),
    ).rejects.toThrow(ForbiddenException);
    expect(core.assertMaySendAs).toHaveBeenCalledWith(
      'conversation-1',
      'staff-user',
      'business-identity',
    );
    expect(pins.exist).not.toHaveBeenCalled();
    expect(pins.createQueryBuilder).not.toHaveBeenCalled();
  });
});

describe('MessageAnnotationsService.unpinMessage refuses and saves nothing', () => {
  it('rejects a seat that is no longer entitled to act as its identity', async () => {
    const pins = { delete: jest.fn() };
    const core = {
      requireActiveParticipant: jest
        .fn()
        .mockResolvedValue({ identityId: 'business-identity' }),
      assertMaySendAs: jest
        .fn()
        .mockRejectedValue(
          new ForbiddenException({ code: 'IDENTITY_NOT_STAFF' }),
        ),
    };
    const service = Object.create(
      MessageAnnotationsService.prototype,
    ) as MessageAnnotationsService;
    Object.assign(service, { pins, core });

    await expect(
      service.unpinMessage('conversation-1', 'message-1', 'staff-user'),
    ).rejects.toThrow(ForbiddenException);
    expect(core.assertMaySendAs).toHaveBeenCalledWith(
      'conversation-1',
      'staff-user',
      'business-identity',
    );
    expect(pins.delete).not.toHaveBeenCalled();
  });
});
