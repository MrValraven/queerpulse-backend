import { ConversationsService } from './conversations.service';
import {
  ConversationMuteMode,
  ConversationParticipant,
  ConversationRole,
} from './entities/conversation-participant.entity';
import { ConversationKind } from './entities/conversation.entity';

/**
 * PRD-349: `ConversationsService.setMuteMode`, the write half of the
 * mentions-only mute, and its round trip through `getConversation`'s
 * response mapping (`buildConversationSummaries`'s `muteMode: part.muteMode`).
 *
 * Every dependency besides `participants`/`core` is a bare stub: the DM path
 * these tests exercise never reaches them (no group, no last message, no
 * counterpart participant), which keeps this spec's own surface to exactly
 * what it means to prove rather than re-mocking every collaborator
 * `buildConversationSummaries` has.
 */
function buildService(options: { participant: ConversationParticipant }) {
  const participant = options.participant;
  const participantsRepo = {
    find: jest.fn().mockResolvedValue([]), // no counterpart on this DM fixture
    update: jest.fn().mockImplementation((_where: unknown, values: object) => {
      Object.assign(participant, values);
      return Promise.resolve();
    }),
  };
  const conversationsRepo = {
    find: jest.fn().mockResolvedValue([
      {
        id: participant.conversationId,
        kind: ConversationKind.Direct,
        isOfficial: false,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        title: null,
        avatarUrl: null,
        description: null,
        dissolvedAt: null,
        inviteToken: null,
      },
    ]),
  };
  const profilesRepo = { find: jest.fn().mockResolvedValue([]) };
  const core = {
    requireParticipant: jest.fn().mockResolvedValue(participant),
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
    getMessagingPrivacyForUsers: jest
      .fn()
      .mockResolvedValue(
        new Map([[participant.userId, { shareReadReceipts: true }]]),
      ),
  };
  // Task 11: `buildConversationSummaries` always batch-loads every seat's
  // identity now, even on this DM fixture with no counterpart, so
  // `getByIds`/`describeIdentities` need a real (if empty) implementation
  // here, in place of the bare `{}` stand-in this used to get away with.
  const identities = {
    getByIds: jest.fn().mockResolvedValue([]),
    describeIdentities: jest.fn().mockResolvedValue(new Map()),
  };
  // Fix round 1 (Task 11): unused on this DM fixture with no counterpart
  // (`otherParticipant`'s identity branch never runs with an empty
  // `others` array), same reasoning as `identities` above.
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
  return { service, participantsRepo, core };
}

// Reads as the member's own profile identity rather than an arbitrary uuid,
// since later tasks (identity-keyed conversations) copy this fixture.
const MEMBER_PROFILE_IDENTITY_ID = 'profile-identity-of-user-1';

function baseParticipant(
  overrides: Partial<ConversationParticipant> = {},
): ConversationParticipant {
  return {
    id: 'part-1',
    conversationId: 'conv-1',
    userId: 'user-1',
    identityId: MEMBER_PROFILE_IDENTITY_ID,
    role: ConversationRole.Member,
    removedBy: null,
    removedAt: null,
    leftAt: null,
    lastReadAt: null,
    lastReadInstant: null,
    deliveredAt: null,
    clearedAt: null,
    muted: false,
    muteMode: ConversationMuteMode.All,
    mutedUntil: null,
    pinnedAt: null,
    favoritedAt: null,
    archivedAt: null,
    markedUnreadAt: null,
    draft: null,
    ...overrides,
  };
}

describe('ConversationsService.setMuteMode (PRD-349)', () => {
  it('requires participation, then writes ONLY the muteMode column', async () => {
    const participant = baseParticipant();
    const { service, participantsRepo, core } = buildService({ participant });
    const result = await service.setMuteMode(
      'conv-1',
      'user-1',
      ConversationMuteMode.MentionsOnly,
    );
    expect(result).toEqual({ ok: true });
    expect(core.requireParticipant).toHaveBeenCalledWith('conv-1', 'user-1');
    expect(participantsRepo.update).toHaveBeenCalledWith(
      { conversationId: 'conv-1', userId: 'user-1' },
      { muteMode: ConversationMuteMode.MentionsOnly },
    );
  });

  it('does not touch muted/mutedUntil while setting the mode', async () => {
    const participant = baseParticipant({ muted: true, mutedUntil: null });
    const { service, participantsRepo } = buildService({ participant });
    await service.setMuteMode(
      'conv-1',
      'user-1',
      ConversationMuteMode.MentionsOnly,
    );
    const [, values] = participantsRepo.update.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(values).not.toHaveProperty('muted');
    expect(values).not.toHaveProperty('mutedUntil');
    // The mentions-only override wins for push purposes regardless: this
    // spec only proves the WRITE stays independent; the push-side "wins
    // regardless" claim is `isMutedForPlainMessagePush`'s own contract.
    expect(participant.muted).toBe(true);
  });

  it('round-trips through getConversation: a mode set via setMuteMode is read back on the response', async () => {
    const participant = baseParticipant();
    const { service } = buildService({ participant });

    const before = await service.getConversation('conv-1', 'user-1');
    expect(before.muteMode).toBe(ConversationMuteMode.All);

    await service.setMuteMode(
      'conv-1',
      'user-1',
      ConversationMuteMode.MentionsOnly,
    );

    const after = await service.getConversation('conv-1', 'user-1');
    expect(after.muteMode).toBe(ConversationMuteMode.MentionsOnly);
  });
});
