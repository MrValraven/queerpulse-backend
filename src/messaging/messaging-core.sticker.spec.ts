import { BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, Repository } from 'typeorm';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { IdentityAttributionService } from '../identities/identity-attribution.service';
import { IdentitiesService } from '../identities/identities.service';
import { StickerPackStatus } from '../stickers/entities/sticker-pack.entity';
import { Sticker } from '../stickers/entities/sticker.entity';
import { Profile } from '../users/entities/profile.entity';
import { UsersService } from '../users/users.service';
import { Conversation } from './entities/conversation.entity';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { ConversationPinnedMessage } from './entities/conversation-pinned-message.entity';
import { Message, MessageKind } from './entities/message.entity';
import { MessageHide } from './entities/message-hide.entity';
import { MessageReaction } from './entities/message-reaction.entity';
import { MessageStar } from './entities/message-star.entity';
import { MessagingCoreService } from './messaging-core.service';

/**
 * Task 8: the sticker send path. The client sends only a `stickerId`;
 * `MessagingCoreService.postMessage` resolves the row itself and bakes the
 * attachment from it.
 */
const SENDER = '11111111-1111-1111-1111-111111111111';
const CONVERSATION_ID = 'conversation-1';
const PACK_ID = '22222222-2222-2222-2222-222222222222';
const STICKER_ID = '33333333-3333-3333-3333-333333333333';

const publishedSticker: Sticker = {
  id: STICKER_ID,
  packId: PACK_ID,
  pack: {
    id: PACK_ID,
    slug: 'bi-pride',
    name: 'Bi pride',
    description: null,
    status: StickerPackStatus.Published,
    sortOrder: 0,
    coverStickerId: null,
    createdById: SENDER,
    stickers: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  },
  slug: 'bi-reverse',
  label: 'Bi reverse',
  storageKey: 'stickers/bi-pride/bi-reverse.png',
  width: 512,
  height: 512,
  svgSource: '<svg></svg>',
  templateId: 'flag-badge',
  templateParams: {},
  keywords: { en: [], pt: [] },
  sortOrder: 0,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

// Task 7: see the matching constant in `messaging-core.service.spec.ts`.
// This suite exercises sticker resolution, so `postMessage`'s
// `assertMaySendAs` guard is given a trivially-passing setup that stays out
// of its way.
const SENDER_IDENTITY_ID = '44444444-4444-4444-4444-444444444444';

function build(stickerFindOneResult: Sticker | null) {
  const stickerRepository = {
    findOne: jest.fn().mockResolvedValue(stickerFindOneResult),
  };
  const messagesRepository = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((entity: unknown) => entity),
    save: jest.fn((entity: Record<string, unknown>) =>
      Promise.resolve({ id: 'saved-message-id', ...entity }),
    ),
  };
  const participantsRepository = {
    find: jest.fn().mockResolvedValue([{ identityId: SENDER_IDENTITY_ID }]),
    // CW-05: `assertMaySendAs` now asks for the sender's own seat directly
    // through `exist`, an existence check on the exact pair it needs.
    exist: jest.fn().mockResolvedValue(true),
  };
  const identitiesService = {
    resolveProfileIdentityId: jest.fn().mockResolvedValue(SENDER_IDENTITY_ID),
    assertMayActAs: jest.fn().mockResolvedValue(undefined),
  };
  const empty = {} as Record<string, never>;
  const service = new MessagingCoreService(
    empty as unknown as Repository<Conversation>,
    participantsRepository as unknown as Repository<ConversationParticipant>,
    messagesRepository as unknown as Repository<Message>,
    empty as unknown as Repository<MessageReaction>,
    empty as unknown as Repository<ConversationPinnedMessage>,
    empty as unknown as Repository<MessageStar>,
    empty as unknown as Repository<MessageHide>,
    empty as unknown as Repository<ContentModeration>,
    empty as unknown as Repository<Profile>,
    stickerRepository as unknown as Repository<Sticker>,
    empty as unknown as DataSource,
    empty as unknown as EventEmitter2,
    empty as unknown as UsersService,
    identitiesService as unknown as IdentitiesService,
    // Task 11: unused, `buildPostResult` is short-circuited below.
    {
      buildStaffNameResolver: jest
        .fn()
        .mockResolvedValue({ resolve: () => null }),
    } as unknown as IdentityAttributionService,
  );
  // Short-circuit the hydration a genuinely-accepted send would run. This
  // suite asserts only the sticker resolution and validation, mirroring
  // `messaging-core.service.spec.ts`'s own `build` helper.
  jest.spyOn(service, 'buildPostResult').mockResolvedValue({
    view: {} as never,
    response: {} as never,
    isNew: true,
  });
  return { service, messagesRepository, stickerRepository };
}

function sendSticker(
  service: MessagingCoreService,
  stickerId: string,
): Promise<unknown> {
  return service.postMessage(
    CONVERSATION_ID,
    SENDER,
    'Sticker',
    undefined,
    undefined,
    false,
    'sticker',
    undefined,
    stickerId,
  );
}

function sendStickerWithAttachment(
  service: MessagingCoreService,
  stickerId: string,
  attachment: { url: string; provider: string },
): Promise<unknown> {
  return service.postMessage(
    CONVERSATION_ID,
    SENDER,
    'Sticker',
    undefined,
    undefined,
    false,
    'sticker',
    attachment,
    stickerId,
  );
}

describe('MessagingCoreService.postMessage: sticker send path (Task 8)', () => {
  it('rejects a send whose stickerId matches no row', async () => {
    const { service } = build(null);

    await expect(
      sendSticker(service, '11111111-1111-4111-8111-111111111111'),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a sticker whose pack is still a draft', async () => {
    const { service } = build({
      ...publishedSticker,
      pack: { ...publishedSticker.pack, status: StickerPackStatus.Draft },
    });

    await expect(sendSticker(service, publishedSticker.id)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects a sticker send that also carries an attachment', async () => {
    const { service } = build(publishedSticker);

    await expect(
      sendStickerWithAttachment(service, publishedSticker.id, {
        url: 'message-images/x/y.png',
        provider: 'upload',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('bakes the attachment from the row, ignoring anything the client sent', async () => {
    const { service, messagesRepository } = build(publishedSticker);

    await sendSticker(service, publishedSticker.id);

    expect(messagesRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: MessageKind.Sticker,
        attachment: {
          url: publishedSticker.storageKey,
          previewUrl: publishedSticker.storageKey,
          width: publishedSticker.width,
          height: publishedSticker.height,
          provider: 'sticker',
          stickerId: publishedSticker.id,
          label: publishedSticker.label,
        },
      }),
    );
  });
});
