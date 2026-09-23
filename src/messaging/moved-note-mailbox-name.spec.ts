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
import { Message, MessageKind } from './entities/message.entity';
import { MessageHide } from './entities/message-hide.entity';
import { MessageReaction } from './entities/message-reaction.entity';
import { MessageStar } from './entities/message-star.entity';
import type { SenderIdentityContext } from './author-summary';
import { MessageLike, MessagingCoreService } from './messaging-core.service';
import type { MovedNoteSystemEvent } from './viewer-message-fields';

/**
 * Task 23, part C: the `moved_to_business_mailbox` note migration
 * 1821260000000 writes names the business it moved into, resolved on every
 * read. For a viewer outside the business's staff the note's actor is the
 * business itself, so the owner's personal name and handle never reach the
 * customer.
 *
 * Olga owns Cafe Lisboa and moved her enquiry thread with Marta into its
 * mailbox; Rui is a co-manager.
 */
const CONVERSATION_ID = 'c-moved';
const OWNER = 'owner-olga';
const CO_MANAGER = 'staff-rui';
const CUSTOMER = 'customer-marta';
const LISTING_IDENTITY_ID = 'identity-cafe-lisboa';
const OTHER_LISTING_IDENTITY_ID = 'identity-tiago-studio';
const CUSTOMER_IDENTITY_ID = 'identity-marta';

const OWNER_STRINGS = ['Olga', 'Pereira', 'olga-pereira'];

function seat(userId: string, identityId: string): ConversationParticipant {
  return {
    id: `seat-${userId}`,
    conversationId: CONVERSATION_ID,
    userId,
    identityId,
    role: 'member',
    leftAt: null,
    clearedAt: null,
    deliveredAt: null,
    lastReadAt: null,
  } as unknown as ConversationParticipant;
}

function row(overrides: Partial<MessageLike>): MessageLike {
  return {
    id: 'm1',
    conversationId: CONVERSATION_ID,
    senderId: CUSTOMER,
    senderIdentityId: CUSTOMER_IDENTITY_ID,
    body: 'Is the terrace open?',
    replyToId: null,
    createdAt: new Date('2026-09-22T10:00:00.000Z'),
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

function movedNote(
  id: string,
  mailboxIdentityId: string,
  senderIdentityId: string | null = mailboxIdentityId,
): MessageLike {
  return row({
    id,
    senderId: null,
    senderIdentityId,
    body: 'This conversation moved to the business mailbox',
    kind: MessageKind.System,
    systemEvent: {
      type: 'moved_to_business_mailbox',
      actorId: OWNER,
      value: mailboxIdentityId,
    },
  });
}

function buildService() {
  const identityNames = new Map([
    [LISTING_IDENTITY_ID, 'Cafe Lisboa'],
    [OTHER_LISTING_IDENTITY_ID, 'Tiago Studio'],
  ]);
  const identityKinds = new Map<string, IdentityKind>([
    [LISTING_IDENTITY_ID, IdentityKind.Listing],
    [OTHER_LISTING_IDENTITY_ID, IdentityKind.Listing],
    [CUSTOMER_IDENTITY_ID, IdentityKind.Profile],
  ]);
  const seats = [
    seat(OWNER, LISTING_IDENTITY_ID),
    seat(CO_MANAGER, LISTING_IDENTITY_ID),
    seat(CUSTOMER, CUSTOMER_IDENTITY_ID),
  ];
  const participants = { find: jest.fn().mockResolvedValue(seats) };
  const messages = { find: jest.fn().mockResolvedValue([]) };
  const reactions = { find: jest.fn().mockResolvedValue([]) };
  const pins = { find: jest.fn().mockResolvedValue([]) };
  const stars = { find: jest.fn().mockResolvedValue([]) };
  const hides = { find: jest.fn().mockResolvedValue([]) };
  const moderationStates = { find: jest.fn().mockResolvedValue([]) };
  const conversations = { findOne: jest.fn() };
  const profiles = {
    find: jest.fn().mockResolvedValue([
      {
        userId: OWNER,
        firstName: 'Olga',
        lastName: 'Pereira',
        slug: 'olga-pereira',
        avatarUrl: null,
        photoVisible: true,
      },
      {
        userId: CUSTOMER,
        firstName: 'Marta',
        lastName: 'Silva',
        slug: 'marta-silva',
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
        identityIds
          .filter((identityId) => identityKinds.has(identityId))
          .map((identityId) => ({
            id: identityId,
            kind: identityKinds.get(identityId),
          })),
      ),
    ),
    describeIdentities: jest.fn((identityIds: string[]) =>
      Promise.resolve(
        new Map(
          identityIds
            .filter((identityId) => identityNames.has(identityId))
            .map((identityId) => [
              identityId,
              {
                displayName: identityNames.get(identityId)!,
                handle: 'cafe-lisboa',
                avatarUrl: null,
              },
            ]),
        ),
      ),
    ),
  };
  const identityAttribution = {
    buildStaffNameResolver: jest
      .fn()
      .mockResolvedValue({ resolve: () => null }),
  };
  const empty = {} as Record<string, never>;
  const service = new MessagingCoreService(
    conversations as unknown as Repository<Conversation>,
    participants as unknown as Repository<ConversationParticipant>,
    messages as unknown as Repository<Message>,
    reactions as unknown as Repository<MessageReaction>,
    pins as unknown as Repository<ConversationPinnedMessage>,
    stars as unknown as Repository<MessageStar>,
    hides as unknown as Repository<MessageHide>,
    moderationStates as unknown as Repository<ContentModeration>,
    profiles as unknown as Repository<Profile>,
    empty as unknown as Repository<Sticker>,
    empty as unknown as DataSource,
    empty as unknown as EventEmitter2,
    usersService as unknown as UsersService,
    identities as unknown as IdentitiesService,
    identityAttribution as unknown as IdentityAttributionService,
  );
  const readCalls: jest.Mock[] = [
    participants.find,
    messages.find,
    reactions.find,
    pins.find,
    stars.find,
    hides.find,
    moderationStates.find,
    conversations.findOne,
    profiles.find,
    usersService.findById,
    identities.getByIds,
    identities.describeIdentities,
    identityAttribution.buildStaffNameResolver,
  ];
  const countReads = () =>
    readCalls.reduce((total, mock) => total + mock.mock.calls.length, 0);
  const resetReads = () => readCalls.forEach((mock) => mock.mockClear());
  return {
    service,
    identities,
    identityNames,
    identityKinds,
    countReads,
    resetReads,
  };
}

async function noteFor(
  service: MessagingCoreService,
  note: MessageLike,
  viewerId: string,
): Promise<MovedNoteSystemEvent> {
  const [response] = await service.toMessageResponses(
    [note],
    viewerId,
    false,
    ConversationKind.Direct,
  );
  return response!.systemEvent as MovedNoteSystemEvent;
}

describe('MessagingCoreService.toMessageResponses, the moved note names the business (Task 23)', () => {
  it('reads the listing current name for staff and customer, on every read', async () => {
    const { service, identityNames } = buildService();
    const note = movedNote('note-1', LISTING_IDENTITY_ID);

    for (const viewerId of [OWNER, CO_MANAGER, CUSTOMER]) {
      const systemEvent = await noteFor(service, note, viewerId);
      expect(systemEvent.mailboxName).toBe('Cafe Lisboa');
      expect(systemEvent.isFormerMailbox).toBe(false);
    }

    identityNames.set(LISTING_IDENTITY_ID, 'Cafe Lisboa Terrace');
    for (const viewerId of [OWNER, CUSTOMER]) {
      const systemEvent = await noteFor(service, note, viewerId);
      expect(systemEvent.mailboxName).toBe('Cafe Lisboa Terrace');
    }
  });

  it('reads the former-business name once the identity is deleted', async () => {
    const { service, identityNames, identityKinds } = buildService();
    identityNames.delete(LISTING_IDENTITY_ID);
    identityKinds.delete(LISTING_IDENTITY_ID);
    const note = movedNote('note-1', LISTING_IDENTITY_ID);

    for (const viewerId of [OWNER, CUSTOMER]) {
      const systemEvent = await noteFor(service, note, viewerId);
      expect(systemEvent.mailboxName).toBe('Former business');
      expect(systemEvent.isFormerMailbox).toBe(true);
    }
    const customerEvent = await noteFor(service, note, CUSTOMER);
    expect(customerEvent.actorName).toBe('Former business');
    expect(customerEvent.actorHandle).toBeNull();
  });

  it('names no owner anywhere in the customer copy, and keeps the owner in the staff copy', async () => {
    const { service } = buildService();
    const note = movedNote('note-1', LISTING_IDENTITY_ID);

    const [customerResponse] = await service.toMessageResponses(
      [note],
      CUSTOMER,
      false,
      ConversationKind.Direct,
    );
    const customerEvent = customerResponse!.systemEvent as MovedNoteSystemEvent;
    expect(customerEvent.actorName).toBe('Cafe Lisboa');
    expect(customerEvent.actorHandle).toBeNull();
    expect(customerEvent.actorIsMe).toBe(false);
    const customerSerialized = JSON.stringify(customerResponse);
    for (const ownerString of [...OWNER_STRINGS, OWNER]) {
      expect(customerSerialized).not.toContain(ownerString);
    }

    const ownerEvent = await noteFor(service, note, OWNER);
    expect(ownerEvent.actorName).toBe('Olga Pereira');
    expect(ownerEvent.actorHandle).toBe('olga-pereira');
    expect(ownerEvent.actorIsMe).toBe(true);
    expect(ownerEvent.mailboxName).toBe('Cafe Lisboa');

    const coManagerEvent = await noteFor(service, note, CO_MANAGER);
    expect(coManagerEvent.actorName).toBe('Olga Pereira');
    expect(coManagerEvent.actorIsMe).toBe(false);
  });

  it('costs a page of fifty messages with three notes no read beyond the one identity batch', async () => {
    const { service, identities, countReads, resetReads } = buildService();
    const plainPage = Array.from({ length: 50 }, (_unused, index) =>
      row({ id: `m-${index}` }),
    );
    // Each note names a business no message on the page was sent as, so
    // its description can only come from the page's one batch.
    const pageWithNotes = plainPage.map((message, index) =>
      index === 5 || index === 20 || index === 40
        ? movedNote(`note-${index}`, OTHER_LISTING_IDENTITY_ID, null)
        : message,
    );

    await service.toMessageResponses(
      plainPage,
      CUSTOMER,
      false,
      ConversationKind.Direct,
    );
    const plainReads = countReads();
    resetReads();

    const responses = await service.toMessageResponses(
      pageWithNotes,
      CUSTOMER,
      false,
      ConversationKind.Direct,
    );

    expect(countReads()).toBe(plainReads);
    expect(identities.getByIds).toHaveBeenCalledTimes(1);
    expect(identities.describeIdentities).toHaveBeenCalledTimes(1);
    expect(identities.describeIdentities.mock.calls[0]![0]).toContain(
      OTHER_LISTING_IDENTITY_ID,
    );
    const noteEvents = responses
      .filter((response) => response.kind === 'system')
      .map((response) => response.systemEvent as MovedNoteSystemEvent);
    expect(noteEvents).toHaveLength(3);
    for (const systemEvent of noteEvents) {
      expect(systemEvent.mailboxName).toBe('Tiago Studio');
    }
  });
});

describe('MessagingCoreService.buildLastMessagePreview, the moved note in the inbox (Task 23 cleanup)', () => {
  const profileByUser = new Map(
    [
      {
        userId: OWNER,
        firstName: 'Olga',
        lastName: 'Pereira',
        slug: 'olga-pereira',
        avatarUrl: null,
        photoVisible: true,
      },
    ].map((profile) => [profile.userId, profile as unknown as Profile]),
  );
  const identityContext: SenderIdentityContext = {
    identityKindById: new Map([[LISTING_IDENTITY_ID, IdentityKind.Listing]]),
    identityDescriptionById: new Map([
      [
        LISTING_IDENTITY_ID,
        { displayName: 'Cafe Lisboa', handle: 'cafe-lisboa', avatarUrl: null },
      ],
    ]),
    staffNameResolver: { resolve: () => null },
  };

  function previewFor(
    viewerId: string,
    viewerSeatIdentityId: string | undefined,
    context: SenderIdentityContext | undefined = identityContext,
  ) {
    const { service } = buildService();
    const note = movedNote('note-1', LISTING_IDENTITY_ID) as unknown as Message;
    return service.buildLastMessagePreview(
      note,
      CONVERSATION_ID,
      profileByUser,
      [],
      viewerId,
      context,
      viewerSeatIdentityId,
    );
  }

  it('gives the customer preview the business as its actor and names no owner', () => {
    const preview = previewFor(CUSTOMER, CUSTOMER_IDENTITY_ID);
    const systemEvent = preview.systemEvent as MovedNoteSystemEvent;

    expect(systemEvent.actorName).toBe('Cafe Lisboa');
    expect(systemEvent.actorHandle).toBeNull();
    expect(systemEvent.actorIsMe).toBe(false);
    expect(systemEvent.mailboxName).toBe('Cafe Lisboa');
    const serialized = JSON.stringify(preview);
    for (const ownerString of [...OWNER_STRINGS, OWNER]) {
      expect(serialized).not.toContain(ownerString);
    }
  });

  it('keeps the owner as the actor in a staff preview, as the thread does', () => {
    const ownerEvent = previewFor(OWNER, LISTING_IDENTITY_ID)
      .systemEvent as MovedNoteSystemEvent;
    expect(ownerEvent.actorName).toBe('Olga Pereira');
    expect(ownerEvent.actorIsMe).toBe(true);
    expect(ownerEvent.mailboxName).toBe('Cafe Lisboa');

    const coManagerEvent = previewFor(CO_MANAGER, LISTING_IDENTITY_ID)
      .systemEvent as MovedNoteSystemEvent;
    expect(coManagerEvent.actorName).toBe('Olga Pereira');
    expect(coManagerEvent.actorIsMe).toBe(false);
  });

  it('names no owner when the caller passes no seat or no identity context', () => {
    for (const preview of [
      previewFor(CUSTOMER, undefined),
      previewFor(OWNER, undefined),
      previewFor(CUSTOMER, CUSTOMER_IDENTITY_ID, undefined),
    ]) {
      const serialized = JSON.stringify(preview);
      for (const ownerString of OWNER_STRINGS) {
        expect(serialized).not.toContain(ownerString);
      }
      expect(preview.systemEvent?.actorHandle).toBeNull();
    }
  });
});
