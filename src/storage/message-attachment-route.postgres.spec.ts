import { NotFoundException } from '@nestjs/common';
import { EventEmitter } from 'events';
import { Response } from 'express';
import { PassThrough, Readable } from 'stream';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { Identity, IdentityKind } from '../identities/entities/identity.entity';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { Conversation } from '../messaging/entities/conversation.entity';
import { Message, MessageKind } from '../messaging/entities/message.entity';
import { MESSAGE_SUBJECT_TYPE } from '../messaging/message-visibility-predicates';
import { MessagingCoreService } from '../messaging/messaging-core.service';
import { Block } from '../social/entities/block.entity';
import { Profile } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { FilesController } from './files.controller';
import { StorageService } from './storage.service';

/**
 * Final fix F1 (C1): the opaque message attachment route, authorized by
 * Postgres itself. `GET /files/messages/<messageId>/0` serves a business's
 * photo or document to exactly the readers who may see that message:
 * the customer and live staff get the bytes; a co-manager blocked with the
 * customer, a departed co-manager, a co-manager asking for a message before
 * their history floor, and a stranger get the same 404.
 *
 * It runs against a real database and is skipped unless
 * `MESSAGE_ATTACHMENT_ROUTE_DATABASE_URL` names one. It builds the schema
 * with `synchronize` after dropping every table, so it refuses any database
 * whose name does not end in `_test`. Run it with, for example:
 *
 *   MESSAGE_ATTACHMENT_ROUTE_DATABASE_URL=postgres://postgres@127.0.0.1:55450/attachment_route_test \
 *     npx jest src/storage/message-attachment-route.postgres.spec.ts
 */
const DATABASE_URL = process.env.MESSAGE_ATTACHMENT_ROUTE_DATABASE_URL;
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const OWNER = '10000000-0000-4000-8000-000000000001';
const LIVE_COLLEAGUE = '10000000-0000-4000-8000-000000000002';
const FLOORED_COLLEAGUE = '10000000-0000-4000-8000-000000000003';
const DEPARTED_COLLEAGUE = '10000000-0000-4000-8000-000000000004';
const BLOCKED_COLLEAGUE = '10000000-0000-4000-8000-000000000005';
const CUSTOMER = '10000000-0000-4000-8000-000000000011';
const STRANGER = '10000000-0000-4000-8000-000000000012';
const ALL_USERS = [
  OWNER,
  LIVE_COLLEAGUE,
  FLOORED_COLLEAGUE,
  DEPARTED_COLLEAGUE,
  BLOCKED_COLLEAGUE,
  CUSTOMER,
  STRANGER,
];
const CAFE_IDENTITY_ID = '20000000-0000-4000-8000-000000000001';
const CONVERSATION_ID = '40000000-0000-4000-8000-000000000001';
const PRE_FLOOR_IMAGE_ID = '50000000-0000-4000-8000-000000000001';
const POST_FLOOR_IMAGE_ID = '50000000-0000-4000-8000-000000000002';
const POST_FLOOR_DOCUMENT_ID = '50000000-0000-4000-8000-000000000003';
const DELETED_IMAGE_ID = '50000000-0000-4000-8000-000000000004';
// Fix round N1: a business photo a moderator removed, one a moderator hid,
// and a personal photo the customer sent.
const REMOVED_IMAGE_ID = '50000000-0000-4000-8000-000000000005';
const HIDDEN_IMAGE_ID = '50000000-0000-4000-8000-000000000006';
const PERSONAL_IMAGE_ID = '50000000-0000-4000-8000-000000000007';

const HOUR_MS = 60 * 60 * 1000;
const BASE_TIME = new Date('2026-09-01T09:00:00.000Z').getTime();
const atHour = (hour: number) => new Date(BASE_TIME + hour * HOUR_MS);

function profileIdentityIdOf(userId: string): string {
  return `3${userId.slice(1)}`;
}

function ownerKey(prefix: string, index: number, extension: string): string {
  return `${prefix}/${OWNER}/60000000-0000-4000-8000-${String(index).padStart(12, '0')}${extension}`;
}

async function seedFixture(dataSource: DataSource): Promise<void> {
  await dataSource.getRepository(User).insert(
    ALL_USERS.map((userId) => ({
      id: userId,
      googleId: `google-${userId}`,
      email: `${userId}@example.test`,
    })),
  );
  await dataSource.getRepository(Profile).insert(
    ALL_USERS.map((userId, index) => ({
      userId,
      slug: `member-${index}`,
      firstName: `Member${index}`,
      lastName: 'Fixture',
    })),
  );
  await dataSource.getRepository(Identity).insert([
    { id: CAFE_IDENTITY_ID, kind: IdentityKind.Listing },
    ...ALL_USERS.map((userId) => ({
      id: profileIdentityIdOf(userId),
      kind: IdentityKind.Profile,
      userId,
    })),
  ]);
  await dataSource.getRepository(Conversation).insert({
    id: CONVERSATION_ID,
    createdAt: atHour(0),
    openedAt: atHour(0),
  });
  await dataSource.getRepository(ConversationParticipant).insert([
    {
      conversationId: CONVERSATION_ID,
      userId: CUSTOMER,
      identityId: profileIdentityIdOf(CUSTOMER),
    },
    {
      conversationId: CONVERSATION_ID,
      userId: OWNER,
      identityId: CAFE_IDENTITY_ID,
    },
    {
      conversationId: CONVERSATION_ID,
      userId: LIVE_COLLEAGUE,
      identityId: CAFE_IDENTITY_ID,
    },
    {
      conversationId: CONVERSATION_ID,
      userId: FLOORED_COLLEAGUE,
      identityId: CAFE_IDENTITY_ID,
      clearedAt: atHour(3),
    },
    {
      conversationId: CONVERSATION_ID,
      userId: DEPARTED_COLLEAGUE,
      identityId: CAFE_IDENTITY_ID,
      leftAt: atHour(6),
    },
    {
      conversationId: CONVERSATION_ID,
      userId: BLOCKED_COLLEAGUE,
      identityId: CAFE_IDENTITY_ID,
    },
  ]);
  await dataSource
    .getRepository(Block)
    .insert({ blockerId: CUSTOMER, blockedId: BLOCKED_COLLEAGUE });
  const imageMessage = (id: string, hour: number, index: number) => ({
    id,
    conversationId: CONVERSATION_ID,
    senderId: OWNER,
    senderIdentityId: CAFE_IDENTITY_ID,
    body: '',
    kind: MessageKind.Image,
    attachment: {
      url: ownerKey('message-images', index, '.jpg'),
      previewUrl: ownerKey('message-images', index, '.jpg'),
      width: 800,
      height: 600,
      provider: 'upload',
    },
    createdAt: atHour(hour),
  });
  await dataSource.getRepository(Message).insert([
    imageMessage(PRE_FLOOR_IMAGE_ID, 2, 1),
    imageMessage(POST_FLOOR_IMAGE_ID, 5, 2),
    {
      id: POST_FLOOR_DOCUMENT_ID,
      conversationId: CONVERSATION_ID,
      senderId: OWNER,
      senderIdentityId: CAFE_IDENTITY_ID,
      body: '',
      kind: MessageKind.Document,
      attachment: {
        url: ownerKey('message-documents', 3, '.pdf'),
        fileName: 'menu.pdf',
        byteSize: 8,
        contentType: 'application/pdf',
        provider: 'upload',
      },
      createdAt: atHour(5),
    },
    { ...imageMessage(DELETED_IMAGE_ID, 5, 4), deletedAt: atHour(7) },
    imageMessage(REMOVED_IMAGE_ID, 5, 5),
    imageMessage(HIDDEN_IMAGE_ID, 5, 6),
    {
      ...imageMessage(PERSONAL_IMAGE_ID, 5, 7),
      senderId: CUSTOMER,
      senderIdentityId: profileIdentityIdOf(CUSTOMER),
      attachment: {
        url: `message-images/${CUSTOMER}/60000000-0000-4000-8000-000000000007.jpg`,
        previewUrl: `message-images/${CUSTOMER}/60000000-0000-4000-8000-000000000007.jpg`,
        width: 800,
        height: 600,
        provider: 'upload',
      },
    },
  ]);
  await dataSource.getRepository(ContentModeration).insert([
    {
      subjectType: MESSAGE_SUBJECT_TYPE,
      subjectId: REMOVED_IMAGE_ID,
      removedAt: atHour(8),
    },
    {
      subjectType: MESSAGE_SUBJECT_TYPE,
      subjectId: HIDDEN_IMAGE_ID,
      hiddenAt: atHour(8),
    },
  ]);
}

function streamingResponse() {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on('data', (chunk: Buffer) => chunks.push(chunk));
  const response = Object.assign(sink, {
    req: Object.assign(new EventEmitter(), { method: 'GET' }),
    setHeader: jest.fn(),
    status: jest.fn(),
    redirect: jest.fn(),
  });
  response.status.mockReturnValue(response);
  return { response, body: () => Buffer.concat(chunks).toString() };
}

describeWithDatabase(
  'Final fix F1 (C1): the message attachment route on real Postgres',
  () => {
    let dataSource: DataSource;
    let controller: FilesController;
    let storage: { openObjectStream: jest.Mock };

    beforeAll(async () => {
      const databaseName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
      if (!databaseName.endsWith('_test')) {
        throw new Error(
          `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
        );
      }
      dataSource = new DataSource({
        type: 'postgres',
        url: DATABASE_URL,
        entities: [`${__dirname}/../**/*.entity.ts`],
        namingStrategy: new SnakeNamingStrategy(),
        dropSchema: true,
        synchronize: true,
      });
      await dataSource.initialize();
      await seedFixture(dataSource);
    }, 120000);

    afterAll(async () => {
      await dataSource?.destroy();
    });

    beforeEach(() => {
      (
        FilesController as unknown as { validatedKeys: Set<string> }
      ).validatedKeys.clear();
      storage = {
        openObjectStream: jest.fn((key: string) =>
          Promise.resolve(Readable.from([Buffer.from(`bytes of ${key}`)])),
        ),
      };
      controller = new FilesController(
        {
          ...storage,
          validateImageMagicBytes: jest.fn().mockResolvedValue('valid'),
        } as unknown as StorageService,
        dataSource.getRepository(User),
        dataSource.getRepository(Message),
      );
    });

    async function fetchAs(userId: string, messageId: string) {
      const { response, body } = streamingResponse();
      await controller.serve(
        ['messages', messageId, '0'],
        { userId, email: `${userId}@example.test` } as never,
        response as unknown as Response,
      );
      return body();
    }

    it.each([
      ['the customer', CUSTOMER],
      ['the owner who uploaded it', OWNER],
      ['a live colleague', LIVE_COLLEAGUE],
      ['a colleague whose floor is earlier', FLOORED_COLLEAGUE],
    ])('serves a post-floor business photo to %s', async (_label, userId) => {
      await expect(fetchAs(userId, POST_FLOOR_IMAGE_ID)).resolves.toBe(
        `bytes of ${ownerKey('message-images', 2, '.jpg')}`,
      );
    });

    it('serves a business document to the customer, named from its own row', async () => {
      await expect(fetchAs(CUSTOMER, POST_FLOOR_DOCUMENT_ID)).resolves.toBe(
        `bytes of ${ownerKey('message-documents', 3, '.pdf')}`,
      );
    });

    it.each([
      ['a co-manager blocked with the customer', BLOCKED_COLLEAGUE],
      ['a departed co-manager', DEPARTED_COLLEAGUE],
      ['a stranger', STRANGER],
    ])('refuses %s with 404', async (_label, userId) => {
      await expect(fetchAs(userId, POST_FLOOR_IMAGE_ID)).rejects.toThrow(
        NotFoundException,
      );
      await expect(fetchAs(userId, POST_FLOOR_DOCUMENT_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('refuses a co-manager a photo from before their history floor, which the customer still gets', async () => {
      await expect(
        fetchAs(FLOORED_COLLEAGUE, PRE_FLOOR_IMAGE_ID),
      ).rejects.toThrow(NotFoundException);
      await expect(fetchAs(CUSTOMER, PRE_FLOOR_IMAGE_ID)).resolves.toBe(
        `bytes of ${ownerKey('message-images', 1, '.jpg')}`,
      );
    });

    it.each([
      ['removed', REMOVED_IMAGE_ID],
      ['hid', HIDDEN_IMAGE_ID],
    ])(
      'refuses a business photo a moderator %s, to the customer and the staff',
      async (_label, messageId) => {
        for (const userId of [CUSTOMER, OWNER, LIVE_COLLEAGUE]) {
          await expect(fetchAs(userId, messageId)).rejects.toThrow(
            NotFoundException,
          );
        }
      },
    );

    it('refuses a personal message id, which keeps the key route, to both participants', async () => {
      await expect(fetchAs(OWNER, PERSONAL_IMAGE_ID)).rejects.toThrow(
        NotFoundException,
      );
      await expect(fetchAs(CUSTOMER, PERSONAL_IMAGE_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('refuses a deleted message to everyone', async () => {
      await expect(fetchAs(CUSTOMER, DELETED_IMAGE_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    describe('forwarding by reference', () => {
      function resolveForwardAs(
        userId: string,
        messageId: string,
        kind: MessageKind.Image | MessageKind.Document,
      ) {
        const core = Object.create(
          MessagingCoreService.prototype,
        ) as MessagingCoreService;
        Object.assign(core, {
          messages: dataSource.getRepository(Message),
          usersService: {
            findById: (id: string) =>
              dataSource.getRepository(User).findOne({ where: { id } }),
          },
          storage: {
            copyObjectToOwner: jest.fn((key: string, ownerUserId: string) =>
              Promise.resolve(`copy of ${key} for ${ownerUserId}`),
            ),
          },
        });
        return (
          core as unknown as {
            resolveForwardedAttachmentReference: (
              value: string,
              senderId: string,
              attachmentKind: MessageKind.Image | MessageKind.Document,
              isSentAsMailboxIdentity: boolean,
            ) => Promise<string | null>;
          }
        ).resolveForwardedAttachmentReference(
          `messages/${messageId}/0`,
          userId,
          kind,
          false,
        );
      }

      it('copies a business photo the customer may see under the customer', async () => {
        await expect(
          resolveForwardAs(CUSTOMER, POST_FLOOR_IMAGE_ID, MessageKind.Image),
        ).resolves.toBe(
          `copy of ${ownerKey('message-images', 2, '.jpg')} for ${CUSTOMER}`,
        );
      });

      it.each([
        ['a stranger', STRANGER, POST_FLOOR_IMAGE_ID, MessageKind.Image],
        [
          'a co-manager before their floor',
          FLOORED_COLLEAGUE,
          PRE_FLOOR_IMAGE_ID,
          MessageKind.Image,
        ],
        [
          'a photo sent as a document',
          CUSTOMER,
          POST_FLOOR_IMAGE_ID,
          MessageKind.Document,
        ],
        [
          'a photo a moderator removed',
          CUSTOMER,
          REMOVED_IMAGE_ID,
          MessageKind.Image,
        ],
        ['a personal photo', OWNER, PERSONAL_IMAGE_ID, MessageKind.Image],
      ] as const)('refuses %s', async (_label, userId, messageId, kind) => {
        await expect(resolveForwardAs(userId, messageId, kind)).rejects.toThrow(
          'You may only attach',
        );
      });
    });

    function forwardingCore(copyObjectToOwner: jest.Mock) {
      const core = Object.create(
        MessagingCoreService.prototype,
      ) as MessagingCoreService;
      Object.assign(core, {
        messages: dataSource.getRepository(Message),
        usersService: {
          findById: (id: string) =>
            dataSource.getRepository(User).findOne({ where: { id } }),
        },
        storage: { copyObjectToOwner },
      });
      return core as unknown as {
        resolveForwardedAttachmentReference: (
          value: string,
          senderId: string,
          attachmentKind: MessageKind.Image,
          isSentAsMailboxIdentity: boolean,
        ) => Promise<string | null>;
      };
    }

    async function withSuspended<Result>(
      userId: string,
      run: () => Promise<Result>,
    ): Promise<Result> {
      await dataSource
        .getRepository(User)
        .update({ id: userId }, { status: UserStatus.Suspended });
      try {
        return await run();
      } finally {
        await dataSource
          .getRepository(User)
          .update({ id: userId }, { status: UserStatus.Active });
      }
    }

    it('lets a customer forward a business photo whose staff uploader is suspended, which the route also serves', async () => {
      await withSuspended(OWNER, async () => {
        const copyObjectToOwner = jest.fn((key: string, ownerUserId: string) =>
          Promise.resolve(`copy of ${key} for ${ownerUserId}`),
        );
        await expect(
          forwardingCore(copyObjectToOwner).resolveForwardedAttachmentReference(
            `messages/${POST_FLOOR_IMAGE_ID}/0`,
            CUSTOMER,
            MessageKind.Image,
            false,
          ),
        ).resolves.toBe(
          `copy of ${ownerKey('message-images', 2, '.jpg')} for ${CUSTOMER}`,
        );
        await expect(fetchAs(CUSTOMER, POST_FLOOR_IMAGE_ID)).resolves.toBe(
          `bytes of ${ownerKey('message-images', 2, '.jpg')}`,
        );
      });
    });

    it('still refuses a personal source whose uploader is suspended, on the route and as a forward', async () => {
      await withSuspended(CUSTOMER, async () => {
        const copyObjectToOwner = jest.fn();
        await expect(
          forwardingCore(copyObjectToOwner).resolveForwardedAttachmentReference(
            `messages/${PERSONAL_IMAGE_ID}/0`,
            OWNER,
            MessageKind.Image,
            false,
          ),
        ).rejects.toThrow('You may only attach');
        expect(copyObjectToOwner).not.toHaveBeenCalled();
        await expect(fetchAs(OWNER, PERSONAL_IMAGE_ID)).rejects.toThrow(
          NotFoundException,
        );
      });
    });

    it('never reads bytes for a refused request', async () => {
      await fetchAs(STRANGER, POST_FLOOR_IMAGE_ID).catch(() => null);

      expect(storage.openObjectStream).not.toHaveBeenCalled();
    });
  },
);
