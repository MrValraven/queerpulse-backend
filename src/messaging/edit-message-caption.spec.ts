// The gateway imports the `cookie` package (v2), which is ESM-only and which
// ts-jest cannot load. Mocked exactly like `viewer-message-fields.spec.ts`.
jest.mock('cookie', () => ({ parseCookie: jest.fn(() => ({})) }));
jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, Repository } from 'typeorm';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { IdentityKind } from '../identities/entities/identity.entity';
import { IdentityAttributionService } from '../identities/identity-attribution.service';
import { IdentitiesService } from '../identities/identities.service';
import { Sticker } from '../stickers/entities/sticker.entity';
import { Profile } from '../users/entities/profile.entity';
import { UserRole } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { Conversation, ConversationKind } from './entities/conversation.entity';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { ConversationPinnedMessage } from './entities/conversation-pinned-message.entity';
import {
  DocumentAttachment,
  GifAttachment,
  Message,
  MessageKind,
  StickerAttachment,
} from './entities/message.entity';
import { MessageHide } from './entities/message-hide.entity';
import { MessageReaction } from './entities/message-reaction.entity';
import { MessageStar } from './entities/message-star.entity';
import {
  MESSAGE_KIND_NOT_EDITABLE_CODE,
  MessagesService,
  searchHitText,
} from './messages.service';
import { MessageLike, MessagingCoreService } from './messaging-core.service';

/**
 * ENG-405: Edit on a photo, document or GIF rewrites its caption and leaves
 * the "Photo"/"Document"/"GIF" `body` fallback alone; Edit on a sticker is
 * refused by the endpoint and never offered through `canEdit`.
 */

const CONVERSATION_ID = 'conversation-1';
const AUTHOR = 'author-ana';
const COUNTERPART = 'counterpart-bea';

const PHOTO: GifAttachment = {
  url: 'message-image/author-ana/photo.jpg',
  previewUrl: 'message-image/author-ana/photo.jpg',
  width: 800,
  height: 600,
  provider: 'upload',
  caption: 'Sunset at the pier',
};

const DOCUMENT: DocumentAttachment = {
  url: 'message-document/author-ana/lease.pdf',
  fileName: 'lease.pdf',
  byteSize: 1024,
  contentType: 'application/pdf',
  provider: 'upload',
};

const GIF: GifAttachment = {
  url: 'https://media.example.test/wave.gif',
  previewUrl: 'https://media.example.test/wave-preview.gif',
  width: 200,
  height: 200,
  provider: 'klipy',
};

const STICKER: StickerAttachment = {
  url: 'sticker/pride-flag.png',
  previewUrl: 'sticker/pride-flag.png',
  width: 256,
  height: 256,
  provider: 'sticker',
  stickerId: 'sticker-1',
  label: 'Pride flag',
};

function storedMessage(overrides: Partial<Message>): Message {
  return {
    id: 'message-1',
    conversationId: CONVERSATION_ID,
    senderId: AUTHOR,
    senderIdentityId: null,
    body: 'Photo',
    kind: MessageKind.Image,
    attachment: { ...PHOTO },
    deletedAt: null,
    editedAt: null,
    createdAt: new Date(),
    ...overrides,
  } as Message;
}

/** A `MessagesService` with just what `editMessage` touches. The core keeps
 *  its REAL `sanitizeAttachmentCaption`, so an edited caption goes through
 *  the exact pass a send uses. */
function buildEditService(message: Message) {
  const messages = {
    findOne: jest.fn().mockResolvedValue(message),
    save: jest.fn((saved: Message) => Promise.resolve(saved)),
  };
  const core = {
    requireActiveParticipant: jest.fn().mockResolvedValue({}),
    assertMaySendAs: jest.fn().mockResolvedValue(undefined),
    isMessageTakenDown: jest.fn().mockResolvedValue(false),
    sanitizeAttachmentCaption: (caption: string | undefined) =>
      MessagingCoreService.prototype.sanitizeAttachmentCaption(caption),
    toMessageResponses: jest.fn((views: unknown[]) =>
      Promise.resolve(views.map((view) => ({ view }))),
    ),
  };
  const eventEmitter = { emit: jest.fn() };
  const service = Object.create(MessagesService.prototype) as MessagesService;
  Object.assign(service, { messages, core, eventEmitter });
  return { service, messages, eventEmitter };
}

function savedMessage(messages: {
  save: jest.Mock<Promise<Message>, [Message]>;
}): Message {
  expect(messages.save).toHaveBeenCalledTimes(1);
  return messages.save.mock.calls[0]![0];
}

describe('MessagesService.editMessage on a photo or document (ENG-405)', () => {
  it('rewrites the photo caption and keeps the Photo body fallback', async () => {
    const { service, messages, eventEmitter } = buildEditService(
      storedMessage({}),
    );

    await service.editMessage(
      CONVERSATION_ID,
      'message-1',
      AUTHOR,
      'Sunset at the pier, Lisbon',
    );

    const saved = savedMessage(messages);
    expect(saved.body).toBe('Photo');
    expect(saved.attachment).toEqual({
      ...PHOTO,
      caption: 'Sunset at the pier, Lisbon',
    });
    expect(saved.editedAt).toBeInstanceOf(Date);
    expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
  });

  it('adds a caption to a document sent without one', async () => {
    const { service, messages } = buildEditService(
      storedMessage({
        kind: MessageKind.Document,
        body: 'Document',
        attachment: { ...DOCUMENT },
      }),
    );

    await service.editMessage(
      CONVERSATION_ID,
      'message-1',
      AUTHOR,
      'Signed copy',
    );

    const saved = savedMessage(messages);
    expect(saved.body).toBe('Document');
    expect(saved.attachment).toEqual({ ...DOCUMENT, caption: 'Signed copy' });
  });

  it('sanitizes the edited caption the way a sent caption is sanitized', async () => {
    const { service, messages } = buildEditService(storedMessage({}));

    await service.editMessage(
      CONVERSATION_ID,
      'message-1',
      AUTHOR,
      'Line one\r\nLine two<img src=x onerror=alert(1)>',
    );

    const saved = savedMessage(messages);
    expect(saved.attachment).toEqual({
      ...PHOTO,
      caption: 'Line one\nLine two',
    });
  });

  it('drops the caption key when the edited text sanitizes down to nothing', async () => {
    const { service, messages } = buildEditService(storedMessage({}));

    await service.editMessage(CONVERSATION_ID, 'message-1', AUTHOR, '<b></b>');

    const saved = savedMessage(messages);
    expect(saved.body).toBe('Photo');
    expect(saved.attachment).not.toHaveProperty('caption');
    expect(saved.attachment).toEqual({
      url: PHOTO.url,
      previewUrl: PHOTO.previewUrl,
      width: PHOTO.width,
      height: PHOTO.height,
      provider: PHOTO.provider,
    });
  });

  it('clears the caption with an empty edit and keeps the Photo body', async () => {
    const { service, messages, eventEmitter } = buildEditService(
      storedMessage({}),
    );

    await service.editMessage(CONVERSATION_ID, 'message-1', AUTHOR, '');

    const saved = savedMessage(messages);
    expect(saved.body).toBe('Photo');
    expect(saved.attachment).not.toHaveProperty('caption');
    expect(saved.editedAt).toBeInstanceOf(Date);
    expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
  });

  it('refuses an empty edit on a text message and saves nothing', async () => {
    const { service, messages } = buildEditService(
      storedMessage({
        kind: MessageKind.User,
        body: 'See you at nine',
        attachment: null,
      }),
    );

    await expect(
      service.editMessage(CONVERSATION_ID, 'message-1', AUTHOR, ''),
    ).rejects.toThrow(BadRequestException);
    expect(messages.save).not.toHaveBeenCalled();
  });

  it('refuses a caption longer than a send may carry and saves nothing', async () => {
    const { service, messages } = buildEditService(storedMessage({}));

    await expect(
      service.editMessage(
        CONVERSATION_ID,
        'message-1',
        AUTHOR,
        'a'.repeat(1001),
      ),
    ).rejects.toThrow(BadRequestException);
    expect(messages.save).not.toHaveBeenCalled();
  });

  it('still rewrites the body of an ordinary text message', async () => {
    const { service, messages } = buildEditService(
      storedMessage({
        kind: MessageKind.User,
        body: 'See you at nine',
        attachment: null,
      }),
    );

    await service.editMessage(
      CONVERSATION_ID,
      'message-1',
      AUTHOR,
      'See you at ten',
    );

    const saved = savedMessage(messages);
    expect(saved.body).toBe('See you at ten');
    expect(saved.attachment).toBeNull();
  });
});

describe('MessagesService.editMessage on a GIF (ENG-405)', () => {
  it('adds a caption to a GIF sent without one and keeps the GIF body fallback', async () => {
    const { service, messages, eventEmitter } = buildEditService(
      storedMessage({
        kind: MessageKind.Gif,
        body: 'GIF',
        attachment: { ...GIF },
      }),
    );

    await service.editMessage(
      CONVERSATION_ID,
      'message-1',
      AUTHOR,
      'For the cafe crew',
    );

    const saved = savedMessage(messages);
    expect(saved.body).toBe('GIF');
    expect(saved.attachment).toEqual({ ...GIF, caption: 'For the cafe crew' });
    expect(saved.editedAt).toBeInstanceOf(Date);
    expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
  });

  it('fixes a typo in a GIF caption', async () => {
    const { service, messages } = buildEditService(
      storedMessage({
        kind: MessageKind.Gif,
        body: 'GIF',
        attachment: { ...GIF, caption: 'Hapy birthday' },
      }),
    );

    await service.editMessage(
      CONVERSATION_ID,
      'message-1',
      AUTHOR,
      'Happy birthday',
    );

    const saved = savedMessage(messages);
    expect(saved.body).toBe('GIF');
    expect(saved.attachment).toEqual({ ...GIF, caption: 'Happy birthday' });
  });

  it('clears a GIF caption with an empty edit and keeps the GIF body', async () => {
    const { service, messages } = buildEditService(
      storedMessage({
        kind: MessageKind.Gif,
        body: 'GIF',
        attachment: { ...GIF, caption: 'Hapy birthday' },
      }),
    );

    await service.editMessage(CONVERSATION_ID, 'message-1', AUTHOR, '');

    const saved = savedMessage(messages);
    expect(saved.body).toBe('GIF');
    expect(saved.attachment).toEqual({ ...GIF });
    expect(saved.attachment).not.toHaveProperty('caption');
  });
});

describe('MessagesService.editMessage on a sticker (ENG-405)', () => {
  it('refuses a sticker with the typed code and saves nothing', async () => {
    const { service, messages, eventEmitter } = buildEditService(
      storedMessage({
        kind: MessageKind.Sticker,
        body: '',
        attachment: { ...STICKER },
      }),
    );

    const refusal = service.editMessage(
      CONVERSATION_ID,
      'message-1',
      AUTHOR,
      'New label',
    );

    await expect(refusal).rejects.toThrow(ForbiddenException);
    await expect(refusal).rejects.toMatchObject({
      response: { code: MESSAGE_KIND_NOT_EDITABLE_CODE },
    });
    expect(messages.save).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });
});

describe('searchHitText (ENG-405)', () => {
  it('cuts a photo or document snippet from its caption', () => {
    expect(
      searchHitText({
        kind: MessageKind.Image,
        body: 'Photo',
        attachment: { ...PHOTO },
      }),
    ).toBe('Sunset at the pier');
    expect(
      searchHitText({
        kind: MessageKind.Document,
        body: 'Document',
        attachment: { ...DOCUMENT, caption: 'Signed lease' },
      }),
    ).toBe('Signed lease');
  });

  it('cuts a GIF snippet from its caption and skips the GIF body fallback', () => {
    expect(
      searchHitText({
        kind: MessageKind.Gif,
        body: 'GIF',
        attachment: { ...GIF, caption: 'For the café crew' },
      }),
    ).toBe('For the café crew');
    expect(
      searchHitText({
        kind: MessageKind.Gif,
        body: 'GIF',
        attachment: { ...GIF },
      }),
    ).toBe('');
  });

  it('gives a sticker no snippet text', () => {
    expect(
      searchHitText({
        kind: MessageKind.Sticker,
        body: '',
        attachment: { ...STICKER },
      }),
    ).toBe('');
  });

  it('gives a sticker edited before the fix no snippet text either', () => {
    expect(
      searchHitText({
        kind: MessageKind.Sticker,
        body: 'typed before the fix',
        attachment: { ...STICKER },
      }),
    ).toBe('');
  });

  it('uses the body of an ordinary text message', () => {
    expect(
      searchHitText({
        kind: MessageKind.User,
        body: 'See you at nine',
        attachment: null,
      }),
    ).toBe('See you at nine');
  });
});

// ── canEdit: the flag mirrors the endpoint ───────────────────────────────────

function seat(userId: string): ConversationParticipant {
  return {
    id: `seat-${userId}`,
    conversationId: CONVERSATION_ID,
    userId,
    identityId: `identity-${userId}`,
    role: 'member',
    leftAt: null,
    clearedAt: null,
    deliveredAt: null,
    lastReadAt: null,
  } as unknown as ConversationParticipant;
}

function messageRow(overrides: Partial<MessageLike>): MessageLike {
  return {
    id: 'm1',
    conversationId: CONVERSATION_ID,
    senderId: AUTHOR,
    senderIdentityId: `identity-${AUTHOR}`,
    body: 'Hello',
    replyToId: null,
    createdAt: new Date(),
    editedAt: null,
    deletedAt: null,
    clientMessageId: null,
    forwarded: false,
    kind: MessageKind.User,
    systemEvent: null,
    attachment: null,
    ...overrides,
  };
}

/** Same light harness as `viewer-message-fields.spec.ts`: a personal thread
 *  between two members, nobody staff, no moderation, no hides. */
function buildCoreService(): MessagingCoreService {
  const participants = {
    find: jest.fn().mockResolvedValue([seat(AUTHOR), seat(COUNTERPART)]),
  };
  const emptyFind = { find: jest.fn().mockResolvedValue([]) };
  const profiles = {
    find: jest.fn().mockResolvedValue([
      {
        userId: AUTHOR,
        firstName: 'Ana',
        lastName: 'Sousa',
        slug: 'ana-sousa',
        avatarUrl: null,
        photoVisible: true,
      },
      {
        userId: COUNTERPART,
        firstName: 'Bea',
        lastName: 'Reis',
        slug: 'bea-reis',
        avatarUrl: null,
        photoVisible: true,
      },
    ]),
  };
  const usersService = {
    findById: jest
      .fn()
      .mockImplementation((id: string) =>
        Promise.resolve({ id, role: UserRole.Member }),
      ),
  };
  const identities = {
    getByIds: jest.fn((identityIds: string[]) =>
      Promise.resolve(
        identityIds.map((identityId) => ({
          id: identityId,
          kind: IdentityKind.Profile,
        })),
      ),
    ),
    describeIdentities: jest.fn().mockResolvedValue(new Map()),
    staffUserIds: jest.fn().mockResolvedValue([]),
  };
  const identityAttribution = {
    buildStaffNameResolver: jest
      .fn()
      .mockResolvedValue({ resolve: () => null }),
    loadStaffNameResolverInputs: jest.fn().mockResolvedValue({}),
  };
  const empty = {} as Record<string, never>;
  return new MessagingCoreService(
    { findOne: jest.fn() } as unknown as Repository<Conversation>,
    participants as unknown as Repository<ConversationParticipant>,
    emptyFind as unknown as Repository<Message>,
    emptyFind as unknown as Repository<MessageReaction>,
    emptyFind as unknown as Repository<ConversationPinnedMessage>,
    emptyFind as unknown as Repository<MessageStar>,
    emptyFind as unknown as Repository<MessageHide>,
    emptyFind as unknown as Repository<ContentModeration>,
    profiles as unknown as Repository<Profile>,
    empty as unknown as Repository<Sticker>,
    {
      getRepository: () => ({ find: () => Promise.resolve([]) }),
    } as unknown as DataSource,
    empty as unknown as EventEmitter2,
    usersService as unknown as UsersService,
    identities as unknown as IdentitiesService,
    identityAttribution as unknown as IdentityAttributionService,
  );
}

describe('MessagingCoreService.toMessageResponses canEdit by kind (ENG-405)', () => {
  it('offers Edit on the author own text, photo, document and GIF, and withholds it from a sticker', async () => {
    const service = buildCoreService();
    const rows = [
      messageRow({ id: 'text' }),
      messageRow({
        id: 'photo',
        kind: MessageKind.Image,
        body: 'Photo',
        attachment: { ...PHOTO },
      }),
      messageRow({
        id: 'document',
        kind: MessageKind.Document,
        body: 'Document',
        attachment: { ...DOCUMENT },
      }),
      messageRow({
        id: 'gif',
        kind: MessageKind.Gif,
        body: 'GIF',
        attachment: { ...GIF },
      }),
      messageRow({
        id: 'sticker',
        kind: MessageKind.Sticker,
        body: '',
        attachment: { ...STICKER },
      }),
    ];

    const responses = await service.toMessageResponses(
      rows,
      AUTHOR,
      false,
      ConversationKind.Direct,
    );

    const canEditById = Object.fromEntries(
      responses.map((response) => [response.id, response.canEdit]),
    );
    expect(canEditById).toEqual({
      text: true,
      photo: true,
      document: true,
      gif: true,
      sticker: false,
    });
  });
});

// ── Legacy rows: read-time guards (`legacy-message-body.ts`) ────────────────

describe('MessagingCoreService legacy message rows', () => {
  const EDITED_AT = new Date('2026-09-01T10:00:00.000Z');

  it('reads a raw-key document body as File in the thread', async () => {
    const service = buildCoreService();
    const [response] = await service.toMessageResponses(
      [
        messageRow({
          id: 'document',
          kind: MessageKind.Document,
          body: 'messages:attachments.documentFallbackText',
          attachment: { ...DOCUMENT },
        }),
      ],
      AUTHOR,
      false,
      ConversationKind.Direct,
    );
    expect(response?.body).toBe('File');
  });

  it('reads a raw-key photo body as Photo in the thread', async () => {
    const service = buildCoreService();
    const [response] = await service.toMessageResponses(
      [
        messageRow({
          id: 'photo',
          kind: MessageKind.Image,
          body: 'messages:attachments.fallbackText',
          attachment: { ...PHOTO },
        }),
      ],
      AUTHOR,
      false,
      ConversationKind.Direct,
    );
    expect(response?.body).toBe('Photo');
  });

  it('blanks the body and the edit marker of a sticker edited before the fix', async () => {
    const service = buildCoreService();
    const [response] = await service.toMessageResponses(
      [
        messageRow({
          id: 'sticker',
          kind: MessageKind.Sticker,
          body: 'typed before the fix',
          editedAt: EDITED_AT,
          attachment: { ...STICKER },
        }),
      ],
      AUTHOR,
      false,
      ConversationKind.Direct,
    );
    expect(response?.body).toBe('');
    expect(response?.editedAt).toBeNull();
  });

  it('keeps the body and the edit marker of an edited text message', async () => {
    const service = buildCoreService();
    const [response] = await service.toMessageResponses(
      [messageRow({ id: 'text', body: 'See you at ten', editedAt: EDITED_AT })],
      AUTHOR,
      false,
      ConversationKind.Direct,
    );
    expect(response?.body).toBe('See you at ten');
    expect(response?.editedAt).toBe('2026-09-01T10:00:00.000Z');
  });

  it('previews a raw-key document body as File in the inbox', () => {
    const service = buildCoreService();
    const preview = service.buildLastMessagePreview(
      storedMessage({
        kind: MessageKind.Document,
        body: 'messages:attachments.documentFallbackText',
        attachment: { ...DOCUMENT },
      }),
      CONVERSATION_ID,
      new Map(),
      [],
      AUTHOR,
    );
    expect(preview.body).toBe('File');
  });

  it('previews a sticker edited before the fix as a bare, unedited sticker in the inbox', () => {
    const service = buildCoreService();
    const preview = service.buildLastMessagePreview(
      storedMessage({
        kind: MessageKind.Sticker,
        body: 'typed before the fix',
        editedAt: EDITED_AT,
        attachment: { ...STICKER },
      }),
      CONVERSATION_ID,
      new Map(),
      [],
      AUTHOR,
    );
    expect(preview.body).toBe('');
    expect(preview.editedAt).toBeNull();
  });
});
