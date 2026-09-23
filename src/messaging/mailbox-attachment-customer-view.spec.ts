// The `cookie` package (v2) is ESM-only, which ts-jest cannot load, and the
// chat gateway imports it. Mocked here as the chat specs mock it.
jest.mock('cookie', () => ({ parseCookie: jest.fn(() => ({})) }));
jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));

import { ForbiddenException, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, Repository } from 'typeorm';
import { ChatGateway } from '../chat/chat.gateway';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { IdentityKind } from '../identities/entities/identity.entity';
import { IdentityAttributionService } from '../identities/identity-attribution.service';
import { IdentitiesService } from '../identities/identities.service';
import { OfficialBroadcastsService } from '../official-messages/official-broadcasts.service';
import { Sticker } from '../stickers/entities/sticker.entity';
import { storageKeyOwnerId } from '../storage/storage-key';
import { Profile } from '../users/entities/profile.entity';
import { UserRole, UserStatus } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { ConversationMediaService } from './conversation-media.service';
import { ConversationMediaKind } from './dto/list-conversation-media.query';
import {
  ConversationParticipant,
  ConversationRole,
} from './entities/conversation-participant.entity';
import { ConversationPinnedMessage } from './entities/conversation-pinned-message.entity';
import { Conversation, ConversationKind } from './entities/conversation.entity';
import { MessageHide } from './entities/message-hide.entity';
import { MessageReaction } from './entities/message-reaction.entity';
import { MessageStar } from './entities/message-star.entity';
import { Message, MessageKind } from './entities/message.entity';
import { loadSenderIdentityContext } from './author-summary';
import { resolveAttachment } from './message-response';
import { MessagingCoreService } from './messaging-core.service';
import { ViewerMessageResponse } from './viewer-message-fields';

/**
 * Final fix F1 (C1, C3, B2). C1: a storage key names the member who uploaded
 * it (`<prefix>/<ownerUserId>/<uuid><ext>`), so an image or document a staff
 * member sends AS a business must reach every reader by its message
 * reference (`/files/messages/<messageId>/0`), identical for the customer
 * and the staff, on every read surface. Each test serializes what one reader
 * receives and searches it for the staff member's user id. C3: the house
 * account posts official messages without a seat. B2: the inbox row tells
 * staff which business reply they typed.
 */

const API_BASE_URL = 'https://api.example';
const CONVERSATION_ID = '30000000-0000-4000-8000-000000000001';
const CUSTOMER_ID = '10000000-0000-4000-8000-000000000011';
const STAFF_ID = '10000000-0000-4000-8000-000000000001';
const COLLEAGUE_ID = '10000000-0000-4000-8000-000000000002';
const CUSTOMER_IDENTITY_ID = 'identity-customer';
const STAFF_PROFILE_IDENTITY_ID = 'identity-staff-profile';
const LISTING_IDENTITY_ID = 'identity-listing';
const IMAGE_MESSAGE_ID = '50000000-0000-4000-8000-000000000001';
const DOCUMENT_MESSAGE_ID = '50000000-0000-4000-8000-000000000002';
const REPLY_MESSAGE_ID = '50000000-0000-4000-8000-000000000003';
const PERSONAL_MESSAGE_ID = '50000000-0000-4000-8000-000000000004';
const FILE_SEGMENT = '66666666-7777-4888-9999-000000000000';
const STAFF_IMAGE_KEY = `message-images/${STAFF_ID}/${FILE_SEGMENT}.jpg`;
const STAFF_DOCUMENT_KEY = `message-documents/${STAFF_ID}/${FILE_SEGMENT}.pdf`;

const STAFF_PROFILE = {
  userId: STAFF_ID,
  firstName: 'Tiago',
  lastName: 'Costa',
  slug: 'tiago-costa',
  pronouns: null,
  avatarUrl: null,
  photoVisible: true,
};
const CUSTOMER_PROFILE = {
  userId: CUSTOMER_ID,
  firstName: 'Alex',
  lastName: 'Customer',
  slug: 'alex-customer',
  pronouns: null,
  avatarUrl: null,
  photoVisible: true,
};

function seat(
  overrides: Partial<ConversationParticipant> & { userId: string },
): ConversationParticipant {
  return {
    id: `seat-${overrides.userId}`,
    conversationId: CONVERSATION_ID,
    identityId: LISTING_IDENTITY_ID,
    role: ConversationRole.Member,
    leftAt: null,
    clearedAt: null,
    lastReadAt: null,
    lastReadInstant: null,
    deliveredAt: null,
    ...overrides,
  } as unknown as ConversationParticipant;
}

const THREAD_SEATS = [
  seat({ userId: CUSTOMER_ID, identityId: CUSTOMER_IDENTITY_ID }),
  seat({ userId: STAFF_ID }),
  seat({ userId: COLLEAGUE_ID }),
];

function messageRow(overrides: Partial<Message> = {}): Message {
  return {
    id: IMAGE_MESSAGE_ID,
    conversationId: CONVERSATION_ID,
    senderId: STAFF_ID,
    senderIdentityId: LISTING_IDENTITY_ID,
    body: '',
    replyToId: null,
    createdAt: new Date('2026-01-02T09:00:00.000Z'),
    editedAt: null,
    deletedAt: null,
    clientMessageId: null,
    forwarded: false,
    kind: MessageKind.Image,
    systemEvent: null,
    attachment: {
      url: STAFF_IMAGE_KEY,
      previewUrl: STAFF_IMAGE_KEY,
      width: 800,
      height: 600,
      provider: 'upload',
    },
    attachmentPurgeAfter: null,
    ...overrides,
  } as unknown as Message;
}

const staffImage = () => messageRow();
const staffDocument = () =>
  messageRow({
    id: DOCUMENT_MESSAGE_ID,
    kind: MessageKind.Document,
    attachment: {
      url: STAFF_DOCUMENT_KEY,
      fileName: 'menu.pdf',
      byteSize: 1024,
      contentType: 'application/pdf',
      provider: 'upload',
    },
  });

function routeUrl(messageId: string): string {
  return `${API_BASE_URL}/files/messages/${messageId}/0`;
}

function expectNoStaffUserId(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(STAFF_ID);
  expect(serialized).not.toContain(STAFF_IMAGE_KEY);
  expect(serialized).not.toContain(STAFF_DOCUMENT_KEY);
}

function identityStandIns() {
  return {
    identities: {
      getByIds: jest.fn().mockResolvedValue([
        { id: CUSTOMER_IDENTITY_ID, kind: IdentityKind.Profile },
        { id: STAFF_PROFILE_IDENTITY_ID, kind: IdentityKind.Profile },
        { id: LISTING_IDENTITY_ID, kind: IdentityKind.Listing },
      ]),
      describeIdentities: jest.fn().mockResolvedValue(
        new Map([
          [
            LISTING_IDENTITY_ID,
            {
              displayName: 'Cafe Lisboa',
              handle: 'cafe-lisboa',
              avatarUrl: null,
            },
          ],
        ]),
      ),
      // Final review I2: the live render groups readers by the identities
      // they staff. The resolver below names nobody for any reader, so no
      // reader staffs anything here.
      staffUserIds: jest.fn().mockResolvedValue([]),
    },
    identityAttribution: {
      buildStaffNameResolver: jest
        .fn()
        .mockResolvedValue({ resolve: () => null }),
      // Final review I2: the live render reads the resolver's rows once
      // per message and builds each reader's resolver from them.
      loadStaffNameResolverInputs: jest.fn().mockResolvedValue({}),
    },
  };
}

/** A real `MessagingCoreService` over stand-in repositories. */
function buildCore(options: { replyParents?: Message[] } = {}) {
  const empty = {} as Record<string, never>;
  const { identities, identityAttribution } = identityStandIns();
  return new MessagingCoreService(
    {
      findOne: jest.fn().mockResolvedValue({ isOfficial: false }),
    } as unknown as Repository<Conversation>,
    {
      find: jest.fn().mockResolvedValue(THREAD_SEATS),
    } as unknown as Repository<ConversationParticipant>,
    {
      find: jest.fn().mockResolvedValue(options.replyParents ?? []),
    } as unknown as Repository<Message>,
    {
      find: jest.fn().mockResolvedValue([]),
    } as unknown as Repository<MessageReaction>,
    {
      find: jest.fn().mockResolvedValue([]),
    } as unknown as Repository<ConversationPinnedMessage>,
    {
      find: jest.fn().mockResolvedValue([]),
    } as unknown as Repository<MessageStar>,
    {
      find: jest.fn().mockResolvedValue([]),
    } as unknown as Repository<MessageHide>,
    {
      find: jest.fn().mockResolvedValue([]),
    } as unknown as Repository<ContentModeration>,
    {
      find: jest.fn().mockResolvedValue([STAFF_PROFILE, CUSTOMER_PROFILE]),
    } as unknown as Repository<Profile>,
    empty as unknown as Repository<Sticker>,
    // Final review I2: the live render reads every viewer's role in one
    // batch; no one here is platform staff, as `findById` below says.
    {
      getRepository: () => ({ find: () => Promise.resolve([]) }),
    } as unknown as DataSource,
    empty as unknown as EventEmitter2,
    {
      findById: jest.fn().mockResolvedValue({ role: UserRole.Member }),
    } as unknown as UsersService,
    identities as unknown as IdentitiesService,
    identityAttribution as unknown as IdentityAttributionService,
  );
}

async function renderThreadFor(
  viewerId: string,
  rows: Message[],
  core = buildCore(),
) {
  return core.toMessageResponses(
    rows,
    viewerId,
    false,
    ConversationKind.Direct,
  );
}

beforeAll(() => {
  setImageUrlBase(API_BASE_URL);
});

afterAll(() => {
  resetImageUrlBaseForTesting();
});

describe('Final fix F1 (C1): a business attachment on every read surface', () => {
  it("renders a staff member's image and document in the customer's thread by message reference, with no staff user id anywhere", async () => {
    const responses = await renderThreadFor(CUSTOMER_ID, [
      staffImage(),
      staffDocument(),
    ]);

    expect(responses[0]?.attachment).toMatchObject({
      url: routeUrl(IMAGE_MESSAGE_ID),
      previewUrl: routeUrl(IMAGE_MESSAGE_ID),
    });
    expect(responses[1]?.attachment).toMatchObject({
      url: routeUrl(DOCUMENT_MESSAGE_ID),
      fileName: 'menu.pdf',
    });
    expectNoStaffUserId(responses);
  });

  it('gives the sender, a colleague and the customer the same attachment URL', async () => {
    const [customerView] = await renderThreadFor(CUSTOMER_ID, [staffImage()]);
    const [senderView] = await renderThreadFor(STAFF_ID, [staffImage()]);
    const [colleagueView] = await renderThreadFor(COLLEAGUE_ID, [staffImage()]);

    expect(senderView?.attachment).toEqual(customerView?.attachment);
    expect(colleagueView?.attachment).toEqual(customerView?.attachment);
  });

  it('keeps a personal image on its storage key, exactly as before', async () => {
    const personalImage = messageRow({
      id: PERSONAL_MESSAGE_ID,
      senderId: CUSTOMER_ID,
      senderIdentityId: CUSTOMER_IDENTITY_ID,
      attachment: {
        url: `message-images/${CUSTOMER_ID}/${FILE_SEGMENT}.jpg`,
        previewUrl: `message-images/${CUSTOMER_ID}/${FILE_SEGMENT}.jpg`,
        width: 800,
        height: 600,
        provider: 'upload',
      },
    });

    const [response] = await renderThreadFor(STAFF_ID, [personalImage]);

    expect(response?.attachment?.url).toBe(
      `${API_BASE_URL}/files/message-images/${CUSTOMER_ID}/${FILE_SEGMENT}.jpg`,
    );
  });

  it('renders an image from a business that no longer resolves by message reference', async () => {
    const [response] = await renderThreadFor(CUSTOMER_ID, [
      messageRow({ senderIdentityId: 'identity-deleted-business' }),
    ]);

    expect(response?.attachment?.url).toBe(routeUrl(IMAGE_MESSAGE_ID));
    expectNoStaffUserId(response);
  });

  it("quotes a staff member's image by message reference in the customer's reply", async () => {
    const customerReply = messageRow({
      id: REPLY_MESSAGE_ID,
      senderId: CUSTOMER_ID,
      senderIdentityId: CUSTOMER_IDENTITY_ID,
      kind: MessageKind.User,
      body: 'Lovely',
      attachment: null,
      replyToId: IMAGE_MESSAGE_ID,
    });
    const core = buildCore({ replyParents: [staffImage()] });

    const [response] = await renderThreadFor(
      CUSTOMER_ID,
      [customerReply],
      core,
    );

    expect(response?.replyTo?.thumbnailUrl).toBe(routeUrl(IMAGE_MESSAGE_ID));
    expectNoStaffUserId(response);
  });

  it("previews a staff member's image in the customer's inbox row by message reference", async () => {
    const core = buildCore();
    const { identities, identityAttribution } = identityStandIns();
    const context = await loadSenderIdentityContext(
      { identities, identityAttribution },
      [LISTING_IDENTITY_ID, CUSTOMER_IDENTITY_ID],
      CUSTOMER_ID,
    );

    const preview = core.buildLastMessagePreview(
      staffImage(),
      CONVERSATION_ID,
      new Map(),
      [],
      CUSTOMER_ID,
      context,
      CUSTOMER_IDENTITY_ID,
    );

    expect(preview.attachment?.url).toBe(routeUrl(IMAGE_MESSAGE_ID));
    expectNoStaffUserId(preview);
  });

  it("serves the customer's media gallery page by message reference", async () => {
    const core = buildCore();
    jest.spyOn(core, 'requireParticipant').mockResolvedValue(THREAD_SEATS[0]!);
    const galleryQuery = {} as Record<string, jest.Mock>;
    for (const method of [
      'select',
      'where',
      'andWhere',
      'addSelect',
      'orderBy',
      'addOrderBy',
      'take',
    ]) {
      galleryQuery[method] = jest.fn(() => galleryQuery);
    }
    galleryQuery.getRawAndEntities = jest.fn().mockResolvedValue({
      entities: [staffImage()],
      raw: [],
    });
    const gallery = new ConversationMediaService(
      {
        createQueryBuilder: jest.fn(() => galleryQuery),
      } as unknown as Repository<Message>,
      core,
    );

    const page = await gallery.listConversationMedia(
      CONVERSATION_ID,
      CUSTOMER_ID,
      { kind: ConversationMediaKind.Media },
    );

    expect(page.data[0]?.attachment?.url).toBe(routeUrl(IMAGE_MESSAGE_ID));
    expectNoStaffUserId(page);
  });

  it("sends the customer's live frame by message reference", async () => {
    const core = buildCore();
    const gateway = Object.create(ChatGateway.prototype) as ChatGateway;
    Object.assign(gateway, {
      messagingCore: core,
      logger: new Logger('mailbox-attachment-customer-view'),
    });
    const [senderResponse] = await renderThreadFor(STAFF_ID, [staffImage()]);

    const frames = await (
      gateway as unknown as {
        renderMessageForViewers: (
          message: Message,
          viewerUserIds: string[],
          actorUserId: string,
          actorResponse: unknown,
        ) => Promise<Map<string, ViewerMessageResponse>>;
      }
    ).renderMessageForViewers(
      staffImage(),
      [CUSTOMER_ID, COLLEAGUE_ID, STAFF_ID],
      STAFF_ID,
      senderResponse,
    );

    const customerFrame = frames.get(CUSTOMER_ID);
    expect(customerFrame?.attachment?.url).toBe(routeUrl(IMAGE_MESSAGE_ID));
    expectNoStaffUserId(customerFrame);
    expect(frames.get(COLLEAGUE_ID)?.attachment).toEqual(
      customerFrame?.attachment,
    );
    expect(frames.get(STAFF_ID)?.attachment).toEqual(customerFrame?.attachment);
  });

  it('gives search hits and starred items the message reference through the shared list context', async () => {
    const core = buildCore();
    const rows = [staffImage(), staffDocument()];

    await core.loadMessageListContext(
      [
        {
          id: CONVERSATION_ID,
          kind: ConversationKind.Direct,
          isOfficial: false,
        },
      ],
      rows,
      CUSTOMER_ID,
    );
    // The callers (`MessagesService.searchMessages`,
    // `MessageAnnotationsService.listStarredMessages`) resolve each row's
    // attachment after loading this context.
    const renderedAttachments = rows.map((row) =>
      resolveAttachment(row.attachment),
    );

    expect(renderedAttachments.map((attachment) => attachment?.url)).toEqual([
      routeUrl(IMAGE_MESSAGE_ID),
      routeUrl(DOCUMENT_MESSAGE_ID),
    ]);
    expectNoStaffUserId(renderedAttachments);
  });
});

describe('Final fix F1 (B2): the inbox row tells staff their own reply', () => {
  async function previewFor(viewerId: string, viewerSeatIdentityId: string) {
    const core = buildCore();
    const { identities, identityAttribution } = identityStandIns();
    const context = await loadSenderIdentityContext(
      { identities, identityAttribution },
      [LISTING_IDENTITY_ID, CUSTOMER_IDENTITY_ID],
      viewerId,
    );
    return core.buildLastMessagePreview(
      messageRow({ kind: MessageKind.User, body: 'Hi', attachment: null }),
      CONVERSATION_ID,
      new Map(),
      [],
      viewerId,
      context,
      viewerSeatIdentityId,
    );
  }

  it('marks the business reply as sent by the staff member who typed it', async () => {
    expect(
      (await previewFor(STAFF_ID, LISTING_IDENTITY_ID)).isSentByViewer,
    ).toBe(true);
  });

  it("marks a colleague's business reply as not sent by the viewer", async () => {
    expect(
      (await previewFor(COLLEAGUE_ID, LISTING_IDENTITY_ID)).isSentByViewer,
    ).toBe(false);
  });

  it('gives the customer no key at all', async () => {
    expect(
      await previewFor(CUSTOMER_ID, CUSTOMER_IDENTITY_ID),
    ).not.toHaveProperty('isSentByViewer');
  });
});

describe('Final fix F1 (C1): forwarding a business attachment', () => {
  const FORWARD_SOURCE_ID = IMAGE_MESSAGE_ID;
  const COPIED_KEY = `message-images/${CUSTOMER_ID}/77777777-7777-4777-8777-777777777777.jpg`;

  function buildSendingCore(options: {
    isSourceVisible: boolean;
    senderIdentityKind: IdentityKind;
    sourceOwnerStatus?: UserStatus;
  }) {
    const core = Object.create(
      MessagingCoreService.prototype,
    ) as MessagingCoreService;
    const sourceQuery = {} as Record<string, jest.Mock>;
    for (const method of ['innerJoin', 'where', 'andWhere']) {
      sourceQuery[method] = jest.fn(() => sourceQuery);
    }
    sourceQuery.getOne = jest
      .fn()
      .mockResolvedValue(options.isSourceVisible ? staffImage() : null);
    // `senderCanForwardAttachment`'s key-based check of the kept key.
    sourceQuery.getCount = jest.fn().mockResolvedValue(1);
    const messages = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((entity: unknown) => entity),
      createQueryBuilder: jest.fn(() => sourceQuery),
    };
    const storage = {
      copyObjectToOwner: jest.fn().mockResolvedValue(COPIED_KEY),
    };
    Object.assign(core, {
      messages,
      storage,
      usersService: {
        findById: jest.fn().mockResolvedValue({
          id: STAFF_ID,
          status: options.sourceOwnerStatus ?? UserStatus.Active,
        }),
      },
      participants: { exist: jest.fn().mockResolvedValue(true) },
      identities: {
        resolveProfileIdentityId: jest
          .fn()
          .mockResolvedValue(CUSTOMER_IDENTITY_ID),
        assertMayActAs: jest.fn().mockResolvedValue(undefined),
        getByIds: jest
          .fn()
          .mockResolvedValue([
            { id: LISTING_IDENTITY_ID, kind: options.senderIdentityKind },
          ]),
      },
    });
    const persisted: Message[] = [];
    jest
      .spyOn(
        core as unknown as {
          persistSentMessage: (draft: Message) => Promise<unknown>;
        },
        'persistSentMessage',
      )
      .mockImplementation((draft: Message) => {
        persisted.push(draft);
        return Promise.resolve({ message: draft, implicitClaimedAt: null });
      });
    jest.spyOn(core, 'buildPostResult').mockResolvedValue({
      view: {} as never,
      response: {} as never,
      isNew: true,
    });
    return { core, storage, persisted };
  }

  const forwardedAttachment = {
    url: routeUrl(FORWARD_SOURCE_ID),
    previewUrl: routeUrl(FORWARD_SOURCE_ID),
    width: 800,
    height: 600,
    provider: 'upload',
  };

  it("copies a business photo a customer forwards as themself, so the new message's key names the customer", async () => {
    const { core, storage, persisted } = buildSendingCore({
      isSourceVisible: true,
      senderIdentityKind: IdentityKind.Profile,
    });

    await core.postMessage(
      'personal-conversation',
      CUSTOMER_ID,
      '',
      undefined,
      undefined,
      true,
      'image',
      forwardedAttachment,
    );

    expect(storage.copyObjectToOwner).toHaveBeenCalledWith(
      STAFF_IMAGE_KEY,
      CUSTOMER_ID,
    );
    const stored = persisted[0]?.attachment as {
      url: string;
      previewUrl: string;
    };
    expect(stored.url).toBe(COPIED_KEY);
    expect(stored.previewUrl).toBe(COPIED_KEY);
    expect(storageKeyOwnerId(stored.url)).toBe(CUSTOMER_ID);
    expectNoStaffUserId(persisted);
  });

  it('keeps the original key when a staff member forwards it as the business, whose reads render by reference', async () => {
    const { core, storage, persisted } = buildSendingCore({
      isSourceVisible: true,
      senderIdentityKind: IdentityKind.Listing,
    });

    await core.postMessage(
      CONVERSATION_ID,
      COLLEAGUE_ID,
      '',
      undefined,
      undefined,
      true,
      'image',
      forwardedAttachment,
      undefined,
      LISTING_IDENTITY_ID,
    );

    expect(storage.copyObjectToOwner).not.toHaveBeenCalled();
    expect((persisted[0]?.attachment as { url: string }).url).toBe(
      STAFF_IMAGE_KEY,
    );
  });

  it("copies a business photo whose staff uploader is suspended into a customer's personal forward", async () => {
    const { core, storage, persisted } = buildSendingCore({
      isSourceVisible: true,
      senderIdentityKind: IdentityKind.Profile,
      sourceOwnerStatus: UserStatus.Suspended,
    });

    await expect(
      core.postMessage(
        'personal-conversation',
        CUSTOMER_ID,
        '',
        undefined,
        undefined,
        true,
        'image',
        forwardedAttachment,
      ),
    ).resolves.toBeDefined();
    // Controller ruling: the reference route serves these bytes to the same
    // customer whatever the uploader's status, so the copy is made.
    expect(storage.copyObjectToOwner).toHaveBeenCalledWith(
      STAFF_IMAGE_KEY,
      CUSTOMER_ID,
    );
    expect((persisted[0]?.attachment as { url: string }).url).toBe(COPIED_KEY);
  });

  it('refuses a forward of a message the sender cannot see', async () => {
    const { core, storage, persisted } = buildSendingCore({
      isSourceVisible: false,
      senderIdentityKind: IdentityKind.Profile,
    });

    await expect(
      core.postMessage(
        'personal-conversation',
        CUSTOMER_ID,
        '',
        undefined,
        undefined,
        true,
        'image',
        forwardedAttachment,
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(storage.copyObjectToOwner).not.toHaveBeenCalled();
    expect(persisted).toHaveLength(0);
  });
});

describe('Final fix F1 (C3): the house account posts into official threads', () => {
  const HOUSE_ACCOUNT_ID = '10000000-0000-4000-8000-000000000099';

  function buildOfficialCore(options: {
    isOfficialConversation: boolean;
    isSystemSender: boolean;
  }) {
    const core = Object.create(
      MessagingCoreService.prototype,
    ) as MessagingCoreService;
    const saved: Message[] = [];
    Object.assign(core, {
      messages: {
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn((entity: unknown) => entity),
        save: jest.fn((entity: Message) => {
          saved.push(entity);
          return Promise.resolve(entity);
        }),
      },
      // Only the member holds a seat: the house account has none.
      participants: { exist: jest.fn().mockResolvedValue(false) },
      conversations: {
        findOne: jest
          .fn()
          .mockResolvedValue({ isOfficial: options.isOfficialConversation }),
      },
      usersService: {
        findById: jest
          .fn()
          .mockResolvedValue({ isSystem: options.isSystemSender }),
      },
      identities: {
        resolveProfileIdentityId: jest
          .fn()
          .mockResolvedValue('identity-sender-profile'),
        assertMayActAs: jest.fn().mockResolvedValue(undefined),
      },
    });
    jest.spyOn(core, 'buildPostResult').mockImplementation((message) =>
      Promise.resolve({
        view: {} as never,
        response: { id: message.id } as never,
        isNew: true,
      }),
    );
    return { core, saved };
  }

  it('delivers a broadcast to every member through the real send guard', async () => {
    const { core, saved } = buildOfficialCore({
      isOfficialConversation: true,
      isSystemSender: true,
    });
    const broadcasts = Object.create(
      OfficialBroadcastsService.prototype,
    ) as OfficialBroadcastsService;
    Object.assign(broadcasts, {
      core,
      logger: new Logger('mailbox-attachment-customer-view'),
    });

    const deliveredCount = await (
      broadcasts as unknown as {
        postToMembers: (
          broadcast: { id: string; body: string },
          senderId: string,
          memberIds: string[],
          conversationIdByMember: Map<string, string>,
        ) => Promise<number>;
      }
    ).postToMembers(
      { id: 'broadcast-1', body: 'Safety notice' },
      HOUSE_ACCOUNT_ID,
      ['member-1', 'member-2'],
      new Map([
        ['member-1', 'official-1'],
        ['member-2', 'official-2'],
      ]),
    );

    expect(deliveredCount).toBe(2);
    expect(saved.map((message) => message.conversationId)).toEqual([
      'official-1',
      'official-2',
    ]);
  });

  it('still refuses an ordinary member without a seat in an official thread', async () => {
    const { core, saved } = buildOfficialCore({
      isOfficialConversation: true,
      isSystemSender: false,
    });

    await expect(
      core.postMessage('official-1', 'member-3', 'Hello'),
    ).rejects.toMatchObject({
      response: { code: 'IDENTITY_NOT_IN_CONVERSATION' },
    });
    expect(saved).toHaveLength(0);
  });

  it('still refuses the house account in a thread that is not official', async () => {
    const { core, saved } = buildOfficialCore({
      isOfficialConversation: false,
      isSystemSender: true,
    });

    await expect(
      core.postMessage(CONVERSATION_ID, HOUSE_ACCOUNT_ID, 'Hello'),
    ).rejects.toMatchObject({
      response: { code: 'IDENTITY_NOT_IN_CONVERSATION' },
    });
    expect(saved).toHaveLength(0);
  });

  it('still refuses the house account sending as a chosen identity', async () => {
    const { core, saved } = buildOfficialCore({
      isOfficialConversation: true,
      isSystemSender: true,
    });

    await expect(
      core.postMessage(
        'official-1',
        HOUSE_ACCOUNT_ID,
        'Hello',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'identity-sender-profile',
      ),
    ).rejects.toMatchObject({
      response: { code: 'IDENTITY_NOT_IN_CONVERSATION' },
    });
    expect(saved).toHaveLength(0);
  });
});
