import { ConflictException, ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, Repository } from 'typeorm';
import { ConnectionsService } from '../connections/connections.service';
import { BlockFilterService } from '../social/block-filter.service';
import {
  GROUP_ADD_REFUSED_CODE,
  GROUP_DISSOLVED_CODE,
  GROUP_FULL_CODE,
  GroupsService,
} from './groups.service';
import { MessagingCoreService } from './messaging-core.service';
import {
  ConversationParticipant,
  ConversationRole,
} from './entities/conversation-participant.entity';
import { Conversation, ConversationKind } from './entities/conversation.entity';
import { GroupInvite, GroupInviteStatus } from './entities/group-invite.entity';
import { Message, MessageKind } from './entities/message.entity';
import { Profile } from '../users/entities/profile.entity';
import { Identity } from '../identities/entities/identity.entity';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';

// M1 (storage-key impersonation): the group photo is a shared-upload surface
// (any owner/admin of the group edits the same conversation), so the
// interceptor exempts it and `updateGroup` draws the line via
// `assertNoForeignUploadIntroduced` — a foreign photo key is allowed only when
// it is already the stored value (an admin's no-op re-save); pointing the field
// at a NEW foreign upload is refused.
describe('GroupsService.updateGroup foreign photo ownership (M1)', () => {
  const ACTOR_ID = '11111111-1111-1111-1111-111111111111';
  const OTHER_ID = '22222222-2222-2222-2222-222222222222';
  const FILE_SEGMENT = '33333333-3333-3333-3333-333333333333';
  // A well-formed key whose embedded owner segment is NOT the actor.
  const FOREIGN_PHOTO = `group-avatars/${OTHER_ID}/${FILE_SEGMENT}.jpg`;

  let service: GroupsService;
  let conversations: { findOne: jest.Mock; save: jest.Mock };
  let participants: { find: jest.Mock };
  let profiles: { find: jest.Mock };
  let core: {
    requireParticipant: jest.Mock;
    lastMessagesByConversation: jest.Mock;
    unreadCountsByConversation: jest.Mock;
    buildMemberSummaries: jest.Mock;
    buildMemberPreview: jest.Mock;
    reactionSummariesByMessage: jest.Mock;
    buildLastMessagePreview: jest.Mock;
    groupCapabilities: jest.Mock;
    hasUnreadMentionByConversation: jest.Mock;
  };
  let mediaCropService: { getMany: jest.Mock };

  const makeGroup = (avatarUrl: string | null): Conversation =>
    ({
      id: 'c1',
      kind: ConversationKind.Group,
      title: 'Book club',
      avatarUrl,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    }) as unknown as Conversation;

  beforeEach(() => {
    conversations = {
      findOne: jest.fn(),
      save: jest.fn((convo: unknown) => Promise.resolve(convo)),
    };
    participants = {
      find: jest
        .fn()
        .mockResolvedValue([{ userId: ACTOR_ID, clearedAt: null }]),
    };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    core = {
      // An admin of the group (meets the Admin role gate).
      requireParticipant: jest
        .fn()
        .mockResolvedValue({ role: ConversationRole.Admin, leftAt: null }),
      lastMessagesByConversation: jest.fn().mockResolvedValue(new Map()),
      unreadCountsByConversation: jest.fn().mockResolvedValue(new Map()),
      buildMemberSummaries: jest.fn().mockReturnValue([]),
      // ENG-253: `toGroupConversationResponse` calls this unconditionally too.
      buildMemberPreview: jest.fn().mockReturnValue([]),
      reactionSummariesByMessage: jest.fn().mockResolvedValue(new Map()),
      buildLastMessagePreview: jest.fn().mockReturnValue(null),
      groupCapabilities: jest.fn().mockReturnValue({}),
      // PRD-348: `toGroupConversationResponse` calls this unconditionally.
      hasUnreadMentionByConversation: jest.fn().mockResolvedValue(new Map()),
    };
    mediaCropService = { getMany: jest.fn().mockResolvedValue(new Map()) };

    service = new GroupsService(
      conversations as unknown as Repository<Conversation>,
      participants as unknown as Repository<ConversationParticipant>,
      {} as unknown as Repository<Message>,
      profiles as unknown as Repository<Profile>,
      core as unknown as MessagingCoreService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      mediaCropService as never,
      // PRD-364: `PreferencesService`, unused by `updateGroup` (this spec's
      // only path under test). `buildMemberSummaries` is itself mocked above.
      {} as never,
      // PRD-353: `GroupInvite` repository, unused by `updateGroup` (this
      // spec's caller row carries no `role`, so `toGroupConversationResponse`'s
      // `canSeePendingInvites` gate is always false here).
      { find: jest.fn().mockResolvedValue([]) } as never,
      // Task 8: `IdentitiesService`, unused by `updateGroup` (this spec's
      // only path under test stops well before `insertSystemMessage` or
      // `createGroup`).
      {} as never,
    );
    // The group mapper resolves the photo through `toImageUrl`, which throws
    // `Service temporarily unavailable` when the base was never wired — and
    // every fixture here carries a storage key.
    setImageUrlBase('https://api.test');
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  it('lets an admin re-save the unchanged foreign photo already stored', async () => {
    conversations.findOne.mockResolvedValue(makeGroup(FOREIGN_PHOTO));
    await expect(
      service.updateGroup('c1', ACTOR_ID, { avatarUrl: FOREIGN_PHOTO }),
    ).resolves.toBeDefined();
    // Unchanged: no write, no impersonation.
    expect(conversations.save).not.toHaveBeenCalled();
  });

  it('rejects an admin introducing a new foreign photo key', async () => {
    conversations.findOne.mockResolvedValue(makeGroup(null));
    await expect(
      service.updateGroup('c1', ACTOR_ID, { avatarUrl: FOREIGN_PHOTO }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(conversations.save).not.toHaveBeenCalled();
  });
});

// Messaging scan section 8 (Groups): transfer ownership, dissolve, the
// ENG-239 cap, the PRD-354 add gate, and PRD-355 role-change pills.
describe('GroupsService, section 8 (Groups)', () => {
  const OWNER_ID = '10000000-0000-4000-8000-000000000001';
  const ADMIN_ID = '10000000-0000-4000-8000-000000000002';
  const MEMBER_ID = '10000000-0000-4000-8000-000000000003';
  const CONVERSATION_ID = 'g1';

  let service: GroupsService;
  let conversations: {
    findOne: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  };
  let participants: {
    find: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let profiles: { find: jest.Mock };
  let core: {
    requireParticipant: jest.Mock;
    lastMessagesByConversation: jest.Mock;
    unreadCountsByConversation: jest.Mock;
    buildMemberSummaries: jest.Mock;
    buildMemberPreview: jest.Mock;
    reactionSummariesByMessage: jest.Mock;
    buildLastMessagePreview: jest.Mock;
    groupCapabilities: jest.Mock;
    hasUnreadMentionByConversation: jest.Mock;
    buildPostResult: jest.Mock;
    assertInitiatorIsProfile: jest.Mock;
  };
  let manager: {
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    count: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let connectionsService: { acceptedConnectionsAmong: jest.Mock };
  let blockFilter: { blockedAgainstAnyOf: jest.Mock };
  let mediaCropService: { getMany: jest.Mock };
  let preferencesService: {
    getMessagingPrivacyForUsers: jest.Mock;
    getGroupAddPolicyForUsers: jest.Mock;
  };
  let groupInvites: { find: jest.Mock };
  let identities: { resolveProfileIdentityId: jest.Mock };

  /** Task 8: each actor's own profile identity, distinct per user id so a
   *  test asserting a stamped `senderIdentityId` fails if the wrong actor's
   *  identity ever landed on the pill. */
  const profileIdentityOf = (userId: string): string =>
    `profile-identity-of-${userId}`;

  /** An active, non-dissolved group, mutated in place by a write under test
   *  exactly like the real `Conversation` row is, so a later
   *  `toGroupConversationResponse` call reads the post-write state. */
  const activeGroup = (): Conversation =>
    ({
      id: CONVERSATION_ID,
      kind: ConversationKind.Group,
      title: 'Book club',
      avatarUrl: null,
      description: null,
      inviteToken: null,
      dissolvedAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    }) as unknown as Conversation;

  const participantRow = (
    overrides: Partial<ConversationParticipant>,
  ): ConversationParticipant =>
    ({
      id: `p-${String(overrides.userId)}`,
      leftAt: null,
      clearedAt: null,
      removedBy: null,
      lastReadAt: null,
      deliveredAt: null,
      muted: false,
      mutedUntil: null,
      pinnedAt: null,
      favoritedAt: null,
      markedUnreadAt: null,
      role: ConversationRole.Member,
      ...overrides,
    }) as unknown as ConversationParticipant;

  beforeEach(() => {
    manager = {
      create: jest.fn((_entity: unknown, data: unknown) => ({
        ...(data as object),
      })),
      save: jest.fn((entity: unknown) =>
        Promise.resolve({
          id: 'pill-1',
          createdAt: new Date('2026-02-01T00:00:00.000Z'),
          ...(entity as object),
        }),
      ),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      find: jest.fn().mockResolvedValue([]),
      // ENG-239: `addMembers`' in-transaction cap re-check reads the
      // conversation under a row lock and re-counts the active roster.
      // Defaults keep every existing seat-path test under the cap.
      findOne: jest.fn().mockResolvedValue({ id: CONVERSATION_ID }),
      count: jest.fn().mockResolvedValue(0),
    };
    dataSource = {
      transaction: jest.fn(
        async (callback: (m: typeof manager) => Promise<unknown>) =>
          callback(manager),
      ),
    };
    conversations = {
      findOne: jest.fn().mockResolvedValue(activeGroup()),
      save: jest.fn((convo: unknown) => Promise.resolve(convo)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    participants = {
      find: jest
        .fn()
        .mockResolvedValue([
          participantRow({ userId: OWNER_ID, role: ConversationRole.Owner }),
        ]),
      findOne: jest.fn(),
      // `broadcastPill`'s post-pill unarchive step
      // (`.update().set().where().andWhere().execute()`).
      createQueryBuilder: jest.fn(() => {
        const qb: Record<string, jest.Mock> = {};
        const self = (): typeof qb => qb;
        qb.update = jest.fn(self);
        qb.set = jest.fn(self);
        qb.where = jest.fn(self);
        qb.andWhere = jest.fn(self);
        qb.execute = jest.fn().mockResolvedValue({});
        return qb;
      }),
    };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    core = {
      requireParticipant: jest
        .fn()
        .mockResolvedValue(
          participantRow({ userId: OWNER_ID, role: ConversationRole.Owner }),
        ),
      lastMessagesByConversation: jest.fn().mockResolvedValue(new Map()),
      unreadCountsByConversation: jest.fn().mockResolvedValue(new Map()),
      buildMemberSummaries: jest.fn().mockReturnValue([]),
      // ENG-253: `toGroupConversationResponse` calls this unconditionally too.
      buildMemberPreview: jest.fn().mockReturnValue([]),
      reactionSummariesByMessage: jest.fn().mockResolvedValue(new Map()),
      buildLastMessagePreview: jest.fn().mockReturnValue(null),
      groupCapabilities: jest.fn().mockReturnValue({}),
      hasUnreadMentionByConversation: jest.fn().mockResolvedValue(new Map()),
      // The broadcast is best-effort (wrapped in try/catch in
      // `GroupsService`); a bare stub is enough for these tests, none of
      // which assert on the socket payload itself.
      buildPostResult: jest
        .fn()
        .mockResolvedValue({ view: {}, response: { systemEvent: null } }),
      // Task 8: `createGroup`'s reply-only guard. Every actor here starts a
      // group as themselves, so the stub always allows it.
      assertInitiatorIsProfile: jest.fn().mockResolvedValue(undefined),
    };
    eventEmitter = { emit: jest.fn() };
    connectionsService = {
      acceptedConnectionsAmong: jest
        .fn()
        .mockResolvedValue(new Set([MEMBER_ID, ADMIN_ID])),
    };
    blockFilter = {
      blockedAgainstAnyOf: jest.fn().mockResolvedValue(new Set<string>()),
    };
    mediaCropService = { getMany: jest.fn().mockResolvedValue(new Map()) };
    preferencesService = {
      getMessagingPrivacyForUsers: jest.fn().mockResolvedValue(new Map()),
      // PRD-353: seat-or-invite split in `addMembers`/`createGroup`: an
      // empty map reads as `connections` for every candidate (the default),
      // matching every test below's pre-existing "always seated" expectation.
      getGroupAddPolicyForUsers: jest.fn().mockResolvedValue(new Map()),
    };
    // PRD-353: read-only in `toGroupConversationResponse`'s `pendingInvites`
    // (an owner/admin caller reaches this); writes in `addMembers`/
    // `createGroup`/`leaveGroup`/`dissolveGroup` go through `manager` instead.
    groupInvites = { find: jest.fn().mockResolvedValue([]) };
    // Task 8: `insertSystemMessage` stamps every pill's `senderIdentityId`
    // with the actor's own profile identity, resolved through here.
    identities = {
      resolveProfileIdentityId: jest
        .fn()
        .mockImplementation((userId: string) =>
          Promise.resolve(profileIdentityOf(userId)),
        ),
    };

    service = new GroupsService(
      conversations as unknown as Repository<Conversation>,
      participants as unknown as Repository<ConversationParticipant>,
      // `postSystemMessage` (used by `updateGroup`) reaches the transaction
      // manager through `this.messages.manager`, the SAME manager every
      // transactional write below shares, mirroring the real
      // `Repository.manager === DataSource.manager` relationship.
      { manager } as unknown as Repository<Message>,
      profiles as unknown as Repository<Profile>,
      core as unknown as MessagingCoreService,
      dataSource as unknown as DataSource,
      eventEmitter as unknown as EventEmitter2,
      connectionsService as unknown as ConnectionsService,
      blockFilter as unknown as BlockFilterService,
      mediaCropService as never,
      preferencesService as never,
      groupInvites as never,
      identities as never,
    );
    setImageUrlBase('https://api.test');
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  describe('transferOwnership (DES-228)', () => {
    it('transfers ownership in one transaction and posts an owner_changed pill', async () => {
      participants.findOne.mockResolvedValue(
        participantRow({ userId: MEMBER_ID }),
      );

      const result = await service.transferOwnership(
        CONVERSATION_ID,
        OWNER_ID,
        MEMBER_ID,
      );

      expect(result).toBeDefined();
      expect(manager.update).toHaveBeenCalledWith(
        ConversationParticipant,
        { id: `p-${MEMBER_ID}` },
        { role: ConversationRole.Owner },
      );
      expect(manager.update).toHaveBeenCalledWith(
        ConversationParticipant,
        { id: `p-${OWNER_ID}` },
        { role: ConversationRole.Admin },
      );
      const savedPill = (
        manager.save.mock.calls as [{ systemEvent: unknown }][]
      ).find(
        ([entity]) =>
          (entity.systemEvent as { type?: string } | undefined)?.type ===
          'owner_changed',
      );
      expect(savedPill).toBeDefined();
      const [[{ systemEvent }]] = [savedPill!];
      expect(systemEvent).toEqual({
        type: 'owner_changed',
        actorId: OWNER_ID,
        targetId: MEMBER_ID,
      });
    });

    it('rejects a non-owner (SERVER-AUTHORITATIVE re-check)', async () => {
      core.requireParticipant.mockResolvedValue(
        participantRow({ userId: ADMIN_ID, role: ConversationRole.Admin }),
      );
      await expect(
        service.transferOwnership(CONVERSATION_ID, ADMIN_ID, MEMBER_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });
  });

  describe('dissolveGroup (PRD-357)', () => {
    it('writes the pill first, severs every active participant strictly after it, and clears the invite link', async () => {
      manager.find.mockResolvedValueOnce([
        { userId: OWNER_ID },
        { userId: MEMBER_ID },
      ]);

      const result = await service.dissolveGroup(CONVERSATION_ID, OWNER_ID);

      expect(result).toBeDefined();
      expect(manager.update).toHaveBeenCalledWith(
        Conversation,
        { id: CONVERSATION_ID },
        { dissolvedAt: expect.any(Date), inviteToken: null },
      );
      expect(manager.update).toHaveBeenCalledWith(
        ConversationParticipant,
        expect.objectContaining({ conversationId: CONVERSATION_ID }),
        { leftAt: expect.any(Date) },
      );
      expect(manager.update).toHaveBeenCalledWith(
        GroupInvite,
        expect.objectContaining({
          conversationId: CONVERSATION_ID,
          status: GroupInviteStatus.Pending,
        }),
        { status: GroupInviteStatus.Revoked, respondedAt: expect.any(Date) },
      );
      // The leftAt written for every severed participant is strictly AFTER
      // the pill's own createdAt.
      const dissolveCall = manager.update.mock.calls.find(
        ([entity]) => entity === Conversation,
      )! as [unknown, unknown, { dissolvedAt: Date }];
      const leftAtCall = manager.update.mock.calls.find(
        ([entity]) => entity === ConversationParticipant,
      )! as [unknown, unknown, { leftAt: Date }];
      expect(leftAtCall[2].leftAt.getTime()).toBeGreaterThan(
        dissolveCall[2].dissolvedAt.getTime(),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'conversation.membership.revoked',
        expect.objectContaining({
          conversationId: CONVERSATION_ID,
          userIds: [OWNER_ID, MEMBER_ID],
        }),
      );
    });

    it('rejects a non-owner and a repeat dissolve (GROUP_DISSOLVED)', async () => {
      core.requireParticipant.mockResolvedValue(
        participantRow({ userId: ADMIN_ID, role: ConversationRole.Admin }),
      );
      await expect(
        service.dissolveGroup(CONVERSATION_ID, ADMIN_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);

      core.requireParticipant.mockResolvedValue(
        participantRow({ userId: OWNER_ID, role: ConversationRole.Owner }),
      );
      conversations.findOne.mockResolvedValue({
        ...activeGroup(),
        dissolvedAt: new Date('2026-01-02T00:00:00.000Z'),
      });
      await expect(
        service.dissolveGroup(CONVERSATION_ID, OWNER_ID),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: GROUP_DISSOLVED_CODE }),
      });
    });
  });

  describe('ENG-239: MAX_GROUP_MEMBERS cap', () => {
    it('refuses addMembers with GROUP_FULL once the active roster is at capacity', async () => {
      const fullRoster = Array.from({ length: 256 }, (_, index) =>
        participantRow({ userId: `active-${index}` }),
      );
      participants.find.mockResolvedValueOnce(fullRoster);
      profiles.find.mockResolvedValueOnce([
        { userId: MEMBER_ID, slug: 'newcomer' },
      ]);

      await expect(
        service.addMembers(CONVERSATION_ID, OWNER_ID, ['newcomer']),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: GROUP_FULL_CODE }),
      });
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('rejects an over-cap createGroup before ever opening a transaction', async () => {
      profiles.find.mockResolvedValueOnce(
        Array.from({ length: 256 }, (_, index) => ({
          userId: `member-${index}`,
          slug: `member-${index}`,
        })),
      );

      await expect(
        service.createGroup(
          OWNER_ID,
          'Huge group',
          Array.from({ length: 256 }, (_, index) => `member-${index}`),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    // Item 6: the pre-transaction count above is only a fast fail; the
    // active roster is re-counted INSIDE the transaction, under a row lock,
    // immediately before seating, so a roster that grew in between still
    // refuses GROUP_FULL instead of seating a 257th member.
    it('refuses GROUP_FULL from the in-transaction re-check even when the pre-check passed', async () => {
      profiles.find.mockResolvedValueOnce([
        { userId: MEMBER_ID, slug: 'newcomer' },
      ]);
      manager.count.mockResolvedValueOnce(256);

      await expect(
        service.addMembers(CONVERSATION_ID, OWNER_ID, ['newcomer']),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: GROUP_FULL_CODE }),
      });
      expect(manager.findOne).toHaveBeenCalledWith(
        Conversation,
        expect.objectContaining({
          where: { id: CONVERSATION_ID },
          lock: { mode: 'pessimistic_write' },
        }),
      );
      expect(manager.save).not.toHaveBeenCalledWith(
        expect.objectContaining({ userId: MEMBER_ID }),
      );
    });
  });

  describe('PRD-354: the add gate refuses a block with ANY active member', () => {
    it('refuses with GROUP_ADD_REFUSED, never naming who blocked whom', async () => {
      participants.find.mockResolvedValueOnce([
        participantRow({ userId: OWNER_ID, role: ConversationRole.Owner }),
        participantRow({ userId: ADMIN_ID, role: ConversationRole.Admin }),
      ]);
      profiles.find.mockResolvedValueOnce([
        { userId: MEMBER_ID, slug: 'blocked-candidate' },
      ]);
      // Blocked with the EXISTING admin, not the adder, still refused.
      blockFilter.blockedAgainstAnyOf.mockResolvedValueOnce(
        new Set([MEMBER_ID]),
      );

      await expect(
        service.addMembers(CONVERSATION_ID, OWNER_ID, ['blocked-candidate']),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: GROUP_ADD_REFUSED_CODE }),
      });
      expect(blockFilter.blockedAgainstAnyOf).toHaveBeenCalledWith(
        [MEMBER_ID],
        expect.arrayContaining([OWNER_ID, ADMIN_ID]),
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });
  });

  describe('PRD-355: role-change pills', () => {
    it('posts member_promoted when the owner promotes a member to admin', async () => {
      participants.findOne.mockResolvedValue(
        participantRow({ userId: MEMBER_ID, role: ConversationRole.Member }),
      );

      await service.changeMemberRole(
        CONVERSATION_ID,
        OWNER_ID,
        MEMBER_ID,
        ConversationRole.Admin,
      );

      expect(manager.update).toHaveBeenCalledWith(
        ConversationParticipant,
        { id: `p-${MEMBER_ID}` },
        { role: ConversationRole.Admin },
      );
      const [firstSaveCall] = manager.save.mock.calls;
      if (!firstSaveCall) {
        throw new Error('expected a system pill to be saved');
      }
      const savedPill = firstSaveCall[0] as {
        systemEvent: { type: string; actorId: string; targetId: string };
      };
      expect(savedPill.systemEvent).toEqual({
        type: 'member_promoted',
        actorId: OWNER_ID,
        targetId: MEMBER_ID,
      });
    });

    it('posts member_demoted when the owner demotes an admin to member', async () => {
      participants.findOne.mockResolvedValue(
        participantRow({ userId: ADMIN_ID, role: ConversationRole.Admin }),
      );

      await service.changeMemberRole(
        CONVERSATION_ID,
        OWNER_ID,
        ADMIN_ID,
        ConversationRole.Member,
      );

      const [firstSaveCall] = manager.save.mock.calls;
      if (!firstSaveCall) {
        throw new Error('expected a system pill to be saved');
      }
      const savedPill = firstSaveCall[0] as { systemEvent: { type: string } };
      expect(savedPill.systemEvent.type).toBe('member_demoted');
    });
  });

  describe('Task 8: system pills stamp the actor profile identity', () => {
    it('stamps the actor profile identity on a group system pill', async () => {
      participants.findOne.mockResolvedValue(
        participantRow({ userId: MEMBER_ID, role: ConversationRole.Member }),
      );

      await service.changeMemberRole(
        CONVERSATION_ID,
        OWNER_ID,
        MEMBER_ID,
        ConversationRole.Admin,
      );

      expect(identities.resolveProfileIdentityId).toHaveBeenCalledWith(
        OWNER_ID,
      );
      const [firstSaveCall] = manager.save.mock.calls;
      if (!firstSaveCall) {
        throw new Error('expected a system pill to be saved');
      }
      const savedPill = firstSaveCall[0] as { senderIdentityId: string };
      // Asserts the stamped VALUE itself: a null here is exactly what
      // `CHK_messages_sender_identity` rejects.
      expect(savedPill.senderIdentityId).toBe(profileIdentityOf(OWNER_ID));
    });
  });

  describe('CW-06: createGroup resolves the creator identity only once', () => {
    it('reuses the reply-only guard resolve for the opening pill', async () => {
      profiles.find.mockResolvedValueOnce([
        { userId: MEMBER_ID, slug: 'newcomer' },
      ]);
      // The shared `manager.save` stub spreads its argument as an object,
      // which breaks the array round trip `createGroup` needs for the
      // (here, empty) created-invites array; this test scopes its own
      // array-aware stub to keep the shared default untouched.
      manager.save.mockImplementation((entity: unknown) =>
        Array.isArray(entity)
          ? Promise.resolve(entity)
          : Promise.resolve({
              id: 'pill-1',
              createdAt: new Date('2026-02-01T00:00:00.000Z'),
              ...(entity as object),
            }),
      );

      await service.createGroup(OWNER_ID, 'Book club', ['newcomer']);

      const ownerResolveCalls =
        identities.resolveProfileIdentityId.mock.calls.filter(
          ([userId]) => userId === OWNER_ID,
        );
      expect(ownerResolveCalls).toHaveLength(1);
      const [firstSaveCall] = manager.save.mock.calls.filter(
        (call) => (call[0] as { kind?: string }).kind === MessageKind.System,
      );
      if (!firstSaveCall) {
        throw new Error('expected the opening system pill to be saved');
      }
      const savedPill = firstSaveCall[0] as { senderIdentityId: string };
      expect(savedPill.senderIdentityId).toBe(profileIdentityOf(OWNER_ID));
    });
  });

  // F2 (C2): `conversation_participants.identity_id` is NOT NULL, so every
  // group seat carries its member's own profile identity. Read for the whole
  // batch at once; get-or-create only for a member with no identity row yet.
  describe('F2: group seats carry each member profile identity', () => {
    const STORED_IDENTITY_OF_MEMBER = 'stored-profile-identity-of-member';

    type SavedSeat = { userId: string; identityId?: string; role?: string };

    const savedSeats = (): SavedSeat[] =>
      manager.save.mock.calls
        .flatMap(([entity]: [unknown]): unknown[] =>
          Array.isArray(entity) ? (entity as unknown[]) : [entity],
        )
        .filter(
          (entity): entity is SavedSeat =>
            typeof entity === 'object' &&
            entity !== null &&
            'role' in entity &&
            'userId' in entity,
        );

    beforeEach(() => {
      // Array round trip for `createGroup`'s batched seat and invite saves.
      manager.save.mockImplementation((entity: unknown) =>
        Array.isArray(entity)
          ? Promise.resolve(entity)
          : Promise.resolve({
              id: 'pill-1',
              createdAt: new Date('2026-02-01T00:00:00.000Z'),
              ...(entity as object),
            }),
      );
      profiles.find.mockResolvedValue([
        { userId: MEMBER_ID, slug: 'newcomer' },
      ]);
    });

    it('createGroup seats the creator under their identity and each member under the stored one, in one read', async () => {
      manager.find.mockImplementation((entity: unknown) =>
        Promise.resolve(
          entity === Identity
            ? [{ id: STORED_IDENTITY_OF_MEMBER, userId: MEMBER_ID }]
            : [],
        ),
      );

      await service.createGroup(OWNER_ID, 'Book club', ['newcomer']);

      expect(savedSeats()).toEqual([
        expect.objectContaining({
          userId: OWNER_ID,
          identityId: profileIdentityOf(OWNER_ID),
        }),
        expect.objectContaining({
          userId: MEMBER_ID,
          identityId: STORED_IDENTITY_OF_MEMBER,
        }),
      ]);
      const identityReads = manager.find.mock.calls.filter(
        ([entity]) => entity === Identity,
      );
      expect(identityReads).toHaveLength(1);
      expect(identities.resolveProfileIdentityId).not.toHaveBeenCalledWith(
        MEMBER_ID,
      );
    });

    it('createGroup mints the identity of a member who has none yet', async () => {
      await service.createGroup(OWNER_ID, 'Book club', ['newcomer']);

      expect(savedSeats()).toContainEqual(
        expect.objectContaining({
          userId: MEMBER_ID,
          identityId: profileIdentityOf(MEMBER_ID),
        }),
      );
    });

    it('addMembers seats a new member under their profile identity', async () => {
      await service.addMembers(CONVERSATION_ID, OWNER_ID, ['newcomer']);

      expect(savedSeats()).toEqual([
        expect.objectContaining({
          userId: MEMBER_ID,
          identityId: profileIdentityOf(MEMBER_ID),
        }),
      ]);
    });
  });

  describe('requireGroupRole: GROUP_DISSOLVED refuses every write past it', () => {
    it('refuses addMembers on a dissolved group', async () => {
      conversations.findOne.mockResolvedValue({
        ...activeGroup(),
        dissolvedAt: new Date('2026-03-01T00:00:00.000Z'),
      });
      await expect(
        service.addMembers(CONVERSATION_ID, OWNER_ID, ['someone']),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: GROUP_DISSOLVED_CODE }),
      });
    });
  });

  // Item 1 (a targeted `conversations.update`, never a full-row `save()` of
  // the `convo` `requireGroupRole` loaded at the top of the request) and
  // item 10 (each pill is best effort, so one failing never 500s an
  // already-committed PATCH or skips the other changed fields' pills).
  describe('updateGroup: targeted update + best-effort pills', () => {
    it('writes only the changed fields via conversations.update, never conversations.save', async () => {
      conversations.findOne.mockResolvedValue(activeGroup());

      await service.updateGroup(CONVERSATION_ID, OWNER_ID, {
        title: 'New name',
      });

      expect(conversations.update).toHaveBeenCalledWith(
        { id: CONVERSATION_ID },
        { title: 'New name' },
      );
      expect(conversations.save).not.toHaveBeenCalled();
    });

    it('only includes the fields that actually changed', async () => {
      conversations.findOne.mockResolvedValue(activeGroup());

      await service.updateGroup(CONVERSATION_ID, OWNER_ID, {
        title: 'New name',
        description: 'New description',
      });

      expect(conversations.update).toHaveBeenCalledWith(
        { id: CONVERSATION_ID },
        { title: 'New name', description: 'New description' },
      );
    });

    it('posts the remaining pills even when one pill fails (best effort)', async () => {
      conversations.findOne.mockResolvedValue(activeGroup());
      let saveCalls = 0;
      manager.save.mockImplementation((entity: unknown) => {
        saveCalls += 1;
        const record = entity as { systemEvent?: { type?: string } };
        if (record.systemEvent?.type === 'group_renamed') {
          return Promise.reject(new Error('boom'));
        }
        return Promise.resolve({
          id: `pill-${saveCalls}`,
          createdAt: new Date('2026-02-01T00:00:00.000Z'),
          ...record,
        });
      });

      // Must not throw: the row write already committed, and a pill
      // failure for `group_renamed` must not stop `group_photo_changed`'s
      // own pill or 500 the PATCH.
      await expect(
        service.updateGroup(CONVERSATION_ID, OWNER_ID, {
          title: 'New name',
          avatarUrl: 'group-avatars/x/y.jpg',
        }),
      ).resolves.toBeDefined();

      const savedTypes = manager.save.mock.calls
        .map(
          ([entity]) =>
            (entity as { systemEvent?: { type?: string } }).systemEvent?.type,
        )
        .filter(Boolean);
      expect(savedTypes).toContain('group_photo_changed');
    });
  });

  // Item 7: two concurrent rotations can both commit, and only the LAST
  // write is actually live; the response must reflect what is really
  // persisted, not the token this particular call generated.
  describe('createOrRotateInviteLink: returns the persisted token', () => {
    it('returns the re-read persisted token, not the one this call generated', async () => {
      // First read: `requireGroupRole`'s own role-gate load. Second read:
      // the POST-update re-read this fix adds, simulating a concurrent
      // rotation that won the race and left a DIFFERENT token live.
      conversations.findOne
        .mockResolvedValueOnce(activeGroup())
        .mockResolvedValueOnce({
          ...activeGroup(),
          inviteToken: 'the-actually-persisted-token',
        });

      const result = await service.createOrRotateInviteLink(
        CONVERSATION_ID,
        OWNER_ID,
      );

      expect(result).toEqual({ inviteToken: 'the-actually-persisted-token' });
    });
  });
});
