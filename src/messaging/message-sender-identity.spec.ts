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
import { MessageLike, MessagingCoreService } from './messaging-core.service';

/**
 * Fix round 1 (Task 11): `MessagingCoreService.toMessageResponses`'s
 * identity-aware `sender`. A message sent AS a mailbox identity must render
 * that identity as the sender (its own name/handle/avatar), never the staff
 * member who actually typed it, with the staff first name riding alongside
 * only when `IdentityAttributionService` says this exact reader is owed it.
 */
const CONVERSATION_ID = 'c-mailbox';
const CUSTOMER_ID = 'customer-1';
const STAFF_ID = 'staff-1';
const LISTING_IDENTITY_ID = 'identity-listing';

function messageRow(overrides: Partial<MessageLike> = {}): MessageLike {
  return {
    id: 'm1',
    conversationId: CONVERSATION_ID,
    senderId: STAFF_ID,
    senderIdentityId: LISTING_IDENTITY_ID,
    body: 'Hello from the cafe',
    replyToId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
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

function buildService(options: { staffFirstNameForReader: string | null }) {
  const empty = {} as Record<string, never>;
  const conversations = { findOne: jest.fn() };
  const participants = { find: jest.fn().mockResolvedValue([]) };
  const messages = { find: jest.fn().mockResolvedValue([]) };
  const reactions = { find: jest.fn().mockResolvedValue([]) };
  const pins = { find: jest.fn().mockResolvedValue([]) };
  const stars = { find: jest.fn().mockResolvedValue([]) };
  const hides = { find: jest.fn().mockResolvedValue([]) };
  const moderationStates = { find: jest.fn().mockResolvedValue([]) };
  const profiles = {
    find: jest.fn().mockResolvedValue([
      {
        userId: STAFF_ID,
        firstName: 'Tiago',
        lastName: 'Costa',
        slug: 'tiago-costa',
        avatarUrl: null,
        photoVisible: true,
      },
    ]),
  };
  const usersService = {
    findById: jest
      .fn()
      .mockResolvedValue({ id: CUSTOMER_ID, role: UserRole.Member }),
  };
  const identities = {
    getByIds: jest
      .fn()
      .mockResolvedValue([
        { id: LISTING_IDENTITY_ID, kind: IdentityKind.Listing },
      ]),
    describeIdentities: jest.fn().mockResolvedValue(
      new Map([
        [
          LISTING_IDENTITY_ID,
          {
            displayName: 'Cafe Lisboa',
            handle: 'cafe-lisboa',
            avatarUrl: 'https://example.test/cafe.png',
          },
        ],
      ]),
    ),
  };
  const identityAttribution = {
    buildStaffNameResolver: jest.fn().mockResolvedValue({
      resolve: () => options.staffFirstNameForReader,
    }),
  };

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
  return { service, identities, identityAttribution };
}

describe('MessagingCoreService.toMessageResponses, identity-aware sender', () => {
  it('serializes a message sent as a listing with the listing display name and handle, with the personal handle absent', async () => {
    const { service } = buildService({ staffFirstNameForReader: null });

    const [response] = await service.toMessageResponses(
      [messageRow()],
      CUSTOMER_ID,
      false,
      ConversationKind.Direct,
    );

    expect(response!.sender.displayName).toBe('Cafe Lisboa');
    expect(response!.sender.handle).toBe('cafe-lisboa');
    // The staff member's OWN personal handle ('tiago-costa') never leaks
    // through, whether attribution allows a name or not.
    expect(response!.sender.handle).not.toBe('tiago-costa');
    expect(response!.sender.staffFirstName).toBeUndefined();
  });

  it('additionally carries the staff first name when read by a colleague of the same mailbox', async () => {
    const { service } = buildService({ staffFirstNameForReader: 'Tiago' });

    const [response] = await service.toMessageResponses(
      [messageRow()],
      STAFF_ID, // a colleague reading their own mailbox's thread
      false,
      ConversationKind.Direct,
    );

    expect(response!.sender.displayName).toBe('Cafe Lisboa');
    expect(response!.sender.handle).toBe('cafe-lisboa');
    expect(response!.sender.staffFirstName).toBe('Tiago');
  });

  it('falls back to the ordinary profile-author path for a Profile-kind sender', async () => {
    const { service, identities } = buildService({
      staffFirstNameForReader: null,
    });
    identities.getByIds.mockResolvedValue([
      { id: LISTING_IDENTITY_ID, kind: IdentityKind.Profile },
    ]);
    identities.describeIdentities.mockResolvedValue(new Map());

    const [response] = await service.toMessageResponses(
      [messageRow()],
      CUSTOMER_ID,
      false,
      ConversationKind.Direct,
    );

    expect(response!.sender.displayName).toBe('Tiago Costa');
    expect(response!.sender.handle).toBe('tiago-costa');
  });

  it('renders the former-business placeholder, never the human, when the identity could not be resolved', async () => {
    // Fix round 2 (Task 11): this test used to assert `displayName ===
    // 'Tiago Costa'`, documenting the exact leak the coordinator's review
    // found: an unresolved identity (in production, one whose listing,
    // persona or company has been deleted) used to fall through to the
    // staff member's own profile, personal handle included. It must never
    // do that again.
    const { service, identities } = buildService({
      staffFirstNameForReader: null,
    });
    identities.getByIds.mockResolvedValue([]);
    identities.describeIdentities.mockResolvedValue(new Map());

    const [response] = await service.toMessageResponses(
      [messageRow()],
      CUSTOMER_ID,
      false,
      ConversationKind.Direct,
    );

    expect(response!.sender.displayName).toBe('Former business');
    expect(response!.sender.handle).toBe('');
    expect(response!.sender.isFormerIdentity).toBe(true);
  });

  it('shows the placeholder for a message sent as a listing that has since been deleted, with no trace of the human anywhere in the payload', async () => {
    // The real path the previous test's mock stands in for: the listing was
    // deleted after sending, cascading its `identities` row away with it
    // (`identities.listing_id` is `ON DELETE CASCADE`), so `getByIds` and
    // `describeIdentities` both come back empty for it, exactly as mocked
    // here. `senderIdentityId` itself survives on the message row (it
    // carries no foreign key, by design), which is how this batch still
    // knows the message was sent AS an identity at all, the fact an ordinary
    // personal message never carries.
    const { service, identities } = buildService({
      staffFirstNameForReader: null,
    });
    identities.getByIds.mockResolvedValue([]);
    identities.describeIdentities.mockResolvedValue(new Map());

    const [response] = await service.toMessageResponses(
      [messageRow()],
      CUSTOMER_ID,
      false,
      ConversationKind.Direct,
    );

    expect(response!.sender.displayName).toBe('Former business');
    expect(response!.sender.handle).toBe('');
    expect(response!.sender.isFormerIdentity).toBe(true);
    expect(response!.sender.staffFirstName).toBeUndefined();

    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain('Tiago');
    expect(serialized).not.toContain('Costa');
    expect(serialized).not.toContain('tiago-costa');
  });
});
