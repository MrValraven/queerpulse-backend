import { IdentityKind } from '../identities/entities/identity.entity';
import { ConversationsService } from './conversations.service';
import {
  ConversationParticipant,
  ConversationRole,
} from './entities/conversation-participant.entity';
import { ConversationKind } from './entities/conversation.entity';
import { FORMER_IDENTITY_DISPLAY_NAME } from './message-response';

/**
 * Fix round 2 (Task 11): `otherParticipant` must never re-attribute a
 * deleted business's thread to the human who once staffed it.
 * `conversation_participants.identity_id` is `ON DELETE CASCADE`, unlike
 * `messages.sender_identity_id` (deliberately no foreign key, see that
 * column's own doc comment), so a deleted identity does not leave a
 * dangling `identity_id` behind: it takes the whole seat row with it. That
 * makes the exposure shape different from the message-level leak, but the
 * customer-facing effect close enough to matter, so `otherParticipant`
 * renders the same `FORMER_IDENTITY_AUTHOR` placeholder in both cases this
 * file covers.
 */
const CONVERSATION_ID = 'c-mailbox';
const CUSTOMER_USER_ID = 'customer-1';
const CUSTOMER_IDENTITY_ID = 'identity-customer';
const STAFF_USER_ID = 'staff-1';
const STAFF_PROFILE = {
  userId: STAFF_USER_ID,
  firstName: 'Tiago',
  lastName: 'Costa',
  slug: 'tiago-costa',
  avatarUrl: null,
  pronouns: null,
  photoVisible: true,
};

function buildService(options: {
  others: ConversationParticipant[];
  profiles?: (typeof STAFF_PROFILE)[];
  identityGetByIdsResult?: { id: string; kind: IdentityKind }[];
}) {
  const customerParticipant = {
    id: 'p-customer',
    conversationId: CONVERSATION_ID,
    userId: CUSTOMER_USER_ID,
    identityId: CUSTOMER_IDENTITY_ID,
    role: ConversationRole.Member,
    clearedAt: null,
    leftAt: null,
    removedAt: null,
    muted: false,
    mutedUntil: null,
    muteMode: 'all',
    pinnedAt: null,
    favoritedAt: null,
    archivedAt: null,
    markedUnreadAt: null,
    draft: null,
    lastReadAt: null,
    lastReadInstant: null,
    deliveredAt: null,
  } as unknown as ConversationParticipant;

  const conversationsRepo = {
    find: jest.fn().mockResolvedValue([
      {
        id: CONVERSATION_ID,
        kind: ConversationKind.Direct,
        isOfficial: false,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        title: null,
        avatarUrl: null,
        description: null,
        dissolvedAt: null,
        inviteToken: null,
        claimedByUserId: null,
        claimedAt: null,
      },
    ]),
  };
  const participantsRepo = {
    find: jest.fn().mockResolvedValue(options.others),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const profilesRepo = {
    find: jest.fn().mockResolvedValue(options.profiles ?? []),
  };
  const core = {
    requireParticipant: jest.fn().mockResolvedValue(customerParticipant),
    lastMessagesByConversation: jest.fn().mockResolvedValue(new Map()),
    unreadCountsByConversation: jest.fn().mockResolvedValue(new Map()),
    reactionSummariesByMessage: jest.fn().mockResolvedValue(new Map()),
    hasUnreadMentionByConversation: jest.fn().mockResolvedValue(new Map()),
  };
  const blockFilter = {
    blockedUserIds: jest.fn().mockResolvedValue(new Set()),
  };
  const eventEmitter = { emit: jest.fn() };
  const dataSource = {};
  const mediaCropService = { getMany: jest.fn().mockResolvedValue(new Map()) };
  const connectionsService = {
    allAcceptedConnectionUserIds: jest.fn().mockResolvedValue([]),
    acceptedSinceByCounterpart: jest.fn().mockResolvedValue(new Map()),
  };
  const preferencesService = {
    getMessagingPrivacyForUsers: jest.fn().mockResolvedValue(new Map()),
  };
  const identities = {
    getByIds: jest
      .fn()
      .mockResolvedValue(
        options.identityGetByIdsResult ?? [
          { id: CUSTOMER_IDENTITY_ID, kind: IdentityKind.Profile },
        ],
      ),
    describeIdentities: jest.fn().mockResolvedValue(new Map()),
  };
  const identityAttribution = {
    buildStaffNameResolver: jest
      .fn()
      .mockResolvedValue({ resolve: () => null }),
  };

  const service = new ConversationsService(
    conversationsRepo as never,
    participantsRepo as never,
    profilesRepo as never,
    core as never,
    blockFilter as never,
    eventEmitter as never,
    dataSource as never,
    mediaCropService as never,
    connectionsService as never,
    preferencesService as never,
    identities as never,
    identityAttribution as never,
  );
  return { service };
}

describe('ConversationsService.getConversation, otherParticipant after an identity is deleted', () => {
  it('shows the former-business placeholder when every staff seat is gone, never a bare null a client would render as an empty header', async () => {
    // Every seat on the mailbox side cascaded away with the identity
    // (`FK_conversation_participants_identity` is `ON DELETE CASCADE`), so
    // the customer's own query for "everyone else in this conversation"
    // returns nothing at all.
    const { service } = buildService({ others: [] });

    const result = await service.getConversation(
      CONVERSATION_ID,
      CUSTOMER_USER_ID,
    );

    expect(result.otherParticipant).not.toBeNull();
    expect(result.otherParticipant?.displayName).toBe(
      FORMER_IDENTITY_DISPLAY_NAME,
    );
    expect(result.otherParticipant?.handle).toBe('');
    expect(result.otherParticipant?.isFormerIdentity).toBe(true);
  });

  it('shows the placeholder, never the staff member behind the seat, when a counterpart identity does not resolve', async () => {
    const staffSeat = {
      id: 'p-staff',
      conversationId: CONVERSATION_ID,
      userId: STAFF_USER_ID,
      identityId: 'identity-gone',
      role: ConversationRole.Member,
      clearedAt: null,
      leftAt: null,
      removedAt: null,
      muted: false,
      mutedUntil: null,
      muteMode: 'all',
      pinnedAt: null,
      favoritedAt: null,
      archivedAt: null,
      markedUnreadAt: null,
      draft: null,
      lastReadAt: null,
      lastReadInstant: null,
      deliveredAt: null,
    } as unknown as ConversationParticipant;
    const { service } = buildService({
      others: [staffSeat],
      // The staff member's own profile IS loaded (their account is very
      // much active); the identity they sent through is simply gone.
      profiles: [STAFF_PROFILE],
      identityGetByIdsResult: [
        { id: CUSTOMER_IDENTITY_ID, kind: IdentityKind.Profile },
        // No entry for 'identity-gone': unresolved, same as a deleted
        // identity's `identities` row.
      ],
    });

    const result = await service.getConversation(
      CONVERSATION_ID,
      CUSTOMER_USER_ID,
    );

    expect(result.otherParticipant?.displayName).toBe(
      FORMER_IDENTITY_DISPLAY_NAME,
    );
    expect(result.otherParticipant?.handle).toBe('');
    const serialized = JSON.stringify(result.otherParticipant);
    expect(serialized).not.toContain('Tiago');
    expect(serialized).not.toContain('Costa');
    expect(serialized).not.toContain('tiago-costa');
  });
});
