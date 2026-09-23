import { IdentityKind } from '../identities/entities/identity.entity';
import { ConversationsService } from './conversations.service';
import {
  ConversationParticipant,
  ConversationRole,
} from './entities/conversation-participant.entity';
import { ConversationKind } from './entities/conversation.entity';

/**
 * Task 11: the collapsed read receipt. A business mailbox seats one
 * `ConversationParticipant` row per staff member, all carrying the mailbox's
 * own identity, so a customer's DM counterpart can be several seats at once.
 * Before this fix, `buildConversationSummaries` read `otherLastReadAt` off
 * whichever seat an unordered `participants.find` happened to return first,
 * here deliberately the seat that has NOT read, so a naive fix (or no fix)
 * fails this test even though a real colleague genuinely has read the
 * message.
 *
 * Scoped to the CUSTOMER's own view, the well-defined side: every row in
 * `others` below is a seat of the one mailbox, so collapsing across all of
 * them (read = ANY seat has read) is unambiguous. See
 * `ConversationsService.buildConversationSummaries`'s own comments for why
 * the reverse (a staff member's view, where `others` mixes the customer's
 * row with colleagues') is intentionally left alone.
 */

const CONVERSATION_ID = 'c-mailbox';
const CUSTOMER_USER_ID = 'customer-1';
const CUSTOMER_IDENTITY_ID = 'identity-customer';
const MAILBOX_IDENTITY_ID = 'identity-mailbox';

function buildService(options: { others: ConversationParticipant[] }) {
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
  const profilesRepo = { find: jest.fn().mockResolvedValue([]) };
  const core = {
    requireParticipant: jest.fn().mockResolvedValue(customerParticipant),
    lastMessagesByConversation: jest.fn().mockResolvedValue(new Map()),
    unreadCountsByConversation: jest.fn().mockResolvedValue(new Map()),
    reactionSummariesByMessage: jest.fn().mockResolvedValue(new Map()),
    hasUnreadMentionByConversation: jest.fn().mockResolvedValue(new Map()),
  };
  const blockFilter = {
    blockedUserIds: jest.fn().mockResolvedValue(new Set()),
    // Task 14: no member here has blocked a business.
    identityBlocksAmong: jest.fn().mockResolvedValue([]),
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
    getByIds: jest.fn().mockResolvedValue([
      { id: CUSTOMER_IDENTITY_ID, kind: IdentityKind.Profile },
      { id: MAILBOX_IDENTITY_ID, kind: IdentityKind.Listing },
      // Task 13c: the ordinary counterpart of the last test below resolves
      // as the `Profile` it is. An identity that does not resolve fails
      // closed (`conversation-mailbox-customer-view.spec.ts`).
      { id: 'identity-other-member', kind: IdentityKind.Profile },
    ]),
    // Fix round 1 (Task 11): `buildConversationSummaries` now also batches
    // display data for `otherParticipant`. This suite asserts the read
    // receipt and `mailboxIdentityId` only, never `otherParticipant`'s own
    // fields, so an empty map (no display data resolved) is enough; it
    // makes the identity branch fall back to the ordinary
    // `toAuthorSummary` path safely.
    describeIdentities: jest.fn().mockResolvedValue(new Map()),
  };
  const identityAttribution = {
    // Never reached: `describeIdentities` above returns no description for
    // either identity, so `otherParticipant`'s identity branch short-circuits
    // before this would be called.
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
  return { service, core, participantsRepo };
}

function staffSeat(
  overrides: Partial<ConversationParticipant>,
): ConversationParticipant {
  return {
    id: `p-${overrides.userId}`,
    conversationId: CONVERSATION_ID,
    userId: 'staff',
    identityId: MAILBOX_IDENTITY_ID,
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
    ...overrides,
  } as unknown as ConversationParticipant;
}

describe('ConversationsService.getConversation, collapsed mailbox read receipt', () => {
  it('reads as read once ANY staff seat has read, even when the FIRST-returned seat has not', async () => {
    // Deliberately unread-first: the seat an unordered query happens to
    // return first has NOT read, and the one that follows has. A fix that
    // merely swapped in a different single seat, still trusting only one
    // seat, would still fail this; only a true collapse across all of them
    // passes it.
    const unreadSeat = staffSeat({
      userId: 'staff-1',
      lastReadAt: null,
      lastReadInstant: null,
    });
    const readSeat = staffSeat({
      userId: 'staff-2',
      lastReadAt: new Date('2026-01-02T10:00:00.000Z'),
      lastReadInstant: new Date('2026-01-02T10:00:05.000Z'),
    });
    const { service } = buildService({ others: [unreadSeat, readSeat] });

    const result = await service.getConversation(
      CONVERSATION_ID,
      CUSTOMER_USER_ID,
    );

    expect(result.otherLastReadAt).toBe('2026-01-02T10:00:00.000Z');
    expect(result.otherLastReadInstant).toBe('2026-01-02T10:00:05.000Z');
    expect(result.mailboxIdentityId).toBe(MAILBOX_IDENTITY_ID);
  });

  it('reads as unread when NO staff seat has read yet', async () => {
    const { service } = buildService({
      others: [
        staffSeat({ userId: 'staff-1', lastReadAt: null }),
        staffSeat({ userId: 'staff-2', lastReadAt: null }),
      ],
    });

    const result = await service.getConversation(
      CONVERSATION_ID,
      CUSTOMER_USER_ID,
    );

    expect(result.otherLastReadAt).toBeNull();
    expect(result.otherLastReadInstant).toBeNull();
  });

  it('leaves an ordinary member-to-member DM (no mailbox identity) unaffected', async () => {
    // Task 13c: the counterpart's own profile identity resolves as a
    // `Profile` in this fixture's `getByIds`, so this is an ordinary DM.
    const OTHER_MEMBER_IDENTITY_ID = 'identity-other-member';
    const { service } = buildService({
      others: [
        {
          id: 'p-other',
          conversationId: CONVERSATION_ID,
          userId: 'other-member',
          identityId: OTHER_MEMBER_IDENTITY_ID,
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
          lastReadAt: new Date('2026-01-02T10:00:00.000Z'),
          lastReadInstant: new Date('2026-01-02T10:00:05.000Z'),
          deliveredAt: null,
        } as unknown as ConversationParticipant,
      ],
    });

    const result = await service.getConversation(
      CONVERSATION_ID,
      CUSTOMER_USER_ID,
    );

    expect(result.mailboxIdentityId).toBeUndefined();
    expect(result.otherLastReadAt).toBe('2026-01-02T10:00:00.000Z');
  });
});
