import { ConflictException, ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, Repository } from 'typeorm';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import {
  ConversationParticipant,
  ConversationRole,
} from './entities/conversation-participant.entity';
import { Conversation, ConversationKind } from './entities/conversation.entity';
import { GroupInvite, GroupInviteStatus } from './entities/group-invite.entity';
import {
  GroupInvitesService,
  INVITE_LINK_INVALID_CODE,
  INVITE_NOT_FOUND_CODE,
  REMOVED_FROM_GROUP_CODE,
} from './group-invites.service';
import { GROUP_DISSOLVED_CODE } from './groups.service';
import { GROUP_ROLE_REQUIRED_CODE } from './message-annotations.service';
import { MessagingCoreService } from './messaging-core.service';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';

describe('GroupInvitesService (messaging scan section 8)', () => {
  const INVITEE_ID = '20000000-0000-4000-8000-000000000001';
  const INVITER_ID = '20000000-0000-4000-8000-000000000002';
  const CONVERSATION_ID = 'g1';
  const INVITE_ID = 'inv1';

  let service: GroupInvitesService;
  let invites: { findOne: jest.Mock; update: jest.Mock; find: jest.Mock };
  let conversations: { findOne: jest.Mock; find: jest.Mock };
  let participants: {
    findOne: jest.Mock;
    find: jest.Mock;
    count: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let profiles: { find: jest.Mock };
  let core: {
    buildPostResult: jest.Mock;
    lastMessagesByConversation: jest.Mock;
    unreadCountsByConversation: jest.Mock;
    buildMemberSummaries: jest.Mock;
    buildMemberPreview: jest.Mock;
    reactionSummariesByMessage: jest.Mock;
    buildLastMessagePreview: jest.Mock;
    groupCapabilities: jest.Mock;
    hasUnreadMentionByConversation: jest.Mock;
  };
  let blockFilter: { blockedAgainstAnyOf: jest.Mock };
  let manager: {
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    findOne: jest.Mock;
    count: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let mediaCropService: { getMany: jest.Mock };
  let preferencesService: { getMessagingPrivacyForUsers: jest.Mock };
  let identities: { resolveProfileIdentityId: jest.Mock };

  /** Task 8: each actor's own profile identity, distinct per user id so a
   *  test asserting a stamped `senderIdentityId` fails if the wrong actor's
   *  identity ever landed on the pill. */
  const profileIdentityOf = (userId: string): string =>
    `profile-identity-of-${userId}`;

  const activeGroup = (): Conversation =>
    ({
      id: CONVERSATION_ID,
      kind: ConversationKind.Group,
      title: 'Book club',
      avatarUrl: null,
      description: null,
      inviteToken: 'tok123',
      dissolvedAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    }) as unknown as Conversation;

  const pendingInvite = (
    overrides: Partial<GroupInvite> = {},
  ): GroupInvite => ({
    id: INVITE_ID,
    conversationId: CONVERSATION_ID,
    inviteeId: INVITEE_ID,
    inviterId: INVITER_ID,
    status: GroupInviteStatus.Pending,
    createdAt: new Date('2026-01-05T00:00:00.000Z'),
    respondedAt: null,
    ...overrides,
  });

  beforeEach(() => {
    invites = {
      findOne: jest.fn().mockResolvedValue(pendingInvite()),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      find: jest.fn().mockResolvedValue([]),
    };
    conversations = {
      findOne: jest.fn().mockResolvedValue(activeGroup()),
      find: jest.fn().mockResolvedValue([]),
    };
    participants = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([{ userId: INVITER_ID }]),
      count: jest.fn().mockResolvedValue(1),
      // One chainable stand-in shared by two very different call shapes:
      // `broadcastPill`'s update-chain (`.update().set().where().andWhere()
      // .execute()`) and `activeMemberCountsByConversation`'s select-chain
      // (`.select().addSelect().where().andWhere().groupBy().getRawMany()`).
      // Every method returns the same object so both chains work; the two
      // terminal calls (`execute`/`getRawMany`) are configured per test.
      createQueryBuilder: jest.fn(() => {
        const qb: Record<string, jest.Mock> = {};
        const self = (): typeof qb => qb;
        qb.update = jest.fn(self);
        qb.set = jest.fn(self);
        qb.select = jest.fn(self);
        qb.addSelect = jest.fn(self);
        qb.where = jest.fn(self);
        qb.andWhere = jest.fn(self);
        qb.groupBy = jest.fn(self);
        qb.execute = jest.fn().mockResolvedValue({});
        qb.getRawMany = jest.fn().mockResolvedValue([]);
        return qb;
      }),
    };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    core = {
      buildPostResult: jest
        .fn()
        .mockResolvedValue({ view: {}, response: { systemEvent: null } }),
      lastMessagesByConversation: jest.fn().mockResolvedValue(new Map()),
      unreadCountsByConversation: jest.fn().mockResolvedValue(new Map()),
      buildMemberSummaries: jest.fn().mockReturnValue([]),
      // ENG-253: `buildGroupConversationResponse` calls this unconditionally too.
      buildMemberPreview: jest.fn().mockReturnValue([]),
      reactionSummariesByMessage: jest.fn().mockResolvedValue(new Map()),
      buildLastMessagePreview: jest.fn().mockReturnValue(null),
      groupCapabilities: jest.fn().mockReturnValue({}),
      hasUnreadMentionByConversation: jest.fn().mockResolvedValue(new Map()),
    };
    blockFilter = {
      blockedAgainstAnyOf: jest.fn().mockResolvedValue(new Set<string>()),
    };
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
      // ENG-239: the in-transaction cap re-check (`accept`/`joinByToken`)
      // reads the conversation under a row lock and re-counts the active
      // roster. Defaults keep every existing seat-path test under the cap;
      // individual tests override `count` to exercise the race.
      findOne: jest.fn().mockResolvedValue({ id: CONVERSATION_ID }),
      count: jest.fn().mockResolvedValue(0),
    };
    dataSource = {
      transaction: jest.fn(
        async (callback: (m: typeof manager) => Promise<unknown>) =>
          callback(manager),
      ),
    };
    eventEmitter = { emit: jest.fn() };
    mediaCropService = { getMany: jest.fn().mockResolvedValue(new Map()) };
    preferencesService = {
      getMessagingPrivacyForUsers: jest.fn().mockResolvedValue(new Map()),
    };
    // Task 8: `insertJoinPill` stamps `senderIdentityId` with the joiner's
    // own profile identity, resolved through here.
    identities = {
      resolveProfileIdentityId: jest
        .fn()
        .mockImplementation((userId: string) =>
          Promise.resolve(profileIdentityOf(userId)),
        ),
    };

    service = new GroupInvitesService(
      invites as unknown as Repository<GroupInvite>,
      conversations as unknown as Repository<Conversation>,
      participants as unknown as Repository<ConversationParticipant>,
      profiles as unknown as Repository<Profile>,
      core as unknown as MessagingCoreService,
      blockFilter as unknown as BlockFilterService,
      dataSource as unknown as DataSource,
      eventEmitter as unknown as EventEmitter2,
      mediaCropService as never,
      preferencesService as never,
      identities as never,
    );
    setImageUrlBase('https://api.test');
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  describe('accept', () => {
    it('seats the invitee, marks the invite accepted, and posts a member_joined pill', async () => {
      const result = await service.accept(INVITE_ID, INVITEE_ID);

      expect(result).toBeDefined();
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: CONVERSATION_ID,
          userId: INVITEE_ID,
          role: ConversationRole.Member,
        }),
      );
      expect(manager.update).toHaveBeenCalledWith(
        GroupInvite,
        { id: INVITE_ID, status: GroupInviteStatus.Pending },
        { status: GroupInviteStatus.Accepted, respondedAt: expect.any(Date) },
      );
      const [pillCall] = manager.save.mock.calls.filter(
        ([entity]: [{ systemEvent?: unknown }]) => entity.systemEvent,
      );
      if (!pillCall) {
        throw new Error('expected a system pill to be saved');
      }
      const pillEntity = pillCall[0] as {
        systemEvent: { type: string; value: string };
      };
      expect(pillEntity.systemEvent).toEqual({
        type: 'member_joined',
        actorId: INVITEE_ID,
        value: 'invite',
      });
    });

    it('stamps the actor profile identity on a member_joined pill', async () => {
      await service.accept(INVITE_ID, INVITEE_ID);

      expect(identities.resolveProfileIdentityId).toHaveBeenCalledWith(
        INVITEE_ID,
      );
      const [pillCall] = manager.save.mock.calls.filter(
        ([entity]: [{ systemEvent?: unknown }]) => entity.systemEvent,
      );
      if (!pillCall) {
        throw new Error('expected a system pill to be saved');
      }
      const pillEntity = pillCall[0] as { senderIdentityId: string };
      // Asserts the stamped VALUE itself: a null here is exactly what
      // `CHK_messages_sender_identity` rejects.
      expect(pillEntity.senderIdentityId).toBe(profileIdentityOf(INVITEE_ID));
    });

    it('reactivates a previously-left row instead of inserting a new one', async () => {
      participants.findOne.mockResolvedValue({
        id: 'p-old',
        clearedAt: null,
        leftAt: new Date('2026-01-02T00:00:00.000Z'),
      });

      await service.accept(INVITE_ID, INVITEE_ID);

      expect(manager.update).toHaveBeenCalledWith(
        ConversationParticipant,
        { id: 'p-old' },
        expect.objectContaining({
          leftAt: null,
          removedBy: null,
          removedAt: null,
        }),
      );
    });

    it('refuses with INVITE_NOT_FOUND when the invite is not addressed to the caller', async () => {
      invites.findOne.mockResolvedValue(
        pendingInvite({ inviteeId: 'someone-else' }),
      );

      await expect(service.accept(INVITE_ID, INVITEE_ID)).rejects.toMatchObject(
        {
          response: expect.objectContaining({ code: INVITE_NOT_FOUND_CODE }),
        },
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('refuses with INVITE_NOT_FOUND when the invite already has a status', async () => {
      invites.findOne.mockResolvedValue(
        pendingInvite({ status: GroupInviteStatus.Declined }),
      );

      await expect(service.accept(INVITE_ID, INVITEE_ID)).rejects.toMatchObject(
        {
          response: expect.objectContaining({ code: INVITE_NOT_FOUND_CODE }),
        },
      );
    });

    it('refuses GROUP_DISSOLVED once the group has ended', async () => {
      conversations.findOne.mockResolvedValue({
        ...activeGroup(),
        dissolvedAt: new Date('2026-03-01T00:00:00.000Z'),
      });

      await expect(
        service.accept(INVITE_ID, INVITEE_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('refuses GROUP_FULL once the active roster is at capacity', async () => {
      participants.find.mockResolvedValue(
        Array.from({ length: 256 }, (_, index) => ({ userId: `m-${index}` })),
      );

      await expect(
        service.accept(INVITE_ID, INVITEE_ID),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('refuses GROUP_ADD_REFUSED when blocked either way with an active member', async () => {
      blockFilter.blockedAgainstAnyOf.mockResolvedValue(new Set([INVITEE_ID]));

      await expect(
        service.accept(INVITE_ID, INVITEE_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    // Item 13: the already-active early return now reads `update`'s
    // `affected` exactly like the transactional branch below it.
    it('refuses with INVITE_NOT_FOUND when the already-active early return loses the accept race', async () => {
      participants.findOne.mockResolvedValue({ id: 'p1', leftAt: null });
      invites.update.mockResolvedValueOnce({ affected: 0 });

      await expect(service.accept(INVITE_ID, INVITEE_ID)).rejects.toMatchObject(
        {
          response: expect.objectContaining({ code: INVITE_NOT_FOUND_CODE }),
        },
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    // ENG-239: the cap is re-checked INSIDE the transaction, under a row
    // lock, so a roster that grew between the pre-check and the commit still
    // refuses GROUP_FULL rather than seating a 257th member.
    it('refuses GROUP_FULL from the in-transaction re-check even when the pre-check passed', async () => {
      manager.count.mockResolvedValueOnce(256);

      await expect(
        service.accept(INVITE_ID, INVITEE_ID),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(manager.findOne).toHaveBeenCalledWith(
        Conversation,
        expect.objectContaining({
          where: { id: CONVERSATION_ID },
          lock: { mode: 'pessimistic_write' },
        }),
      );
      // The seat was never written: the transaction rolled back before it.
      expect(manager.save).not.toHaveBeenCalledWith(
        expect.objectContaining({ userId: INVITEE_ID }),
      );
    });
  });

  // F2 (C2): `conversation_participants.identity_id` is NOT NULL, so the
  // seat a join inserts carries the joiner's own profile identity, the same
  // one resolved for their `member_joined` pill.
  describe('F2: a joined seat carries the joiner profile identity', () => {
    const savedSeat = () =>
      manager.save.mock.calls
        .map(([entity]) => entity as { role?: string; identityId?: string })
        .find((entity) => entity.role === ConversationRole.Member);

    it('accept seats the invitee under their profile identity, resolved once', async () => {
      await service.accept(INVITE_ID, INVITEE_ID);

      expect(savedSeat()).toEqual(
        expect.objectContaining({
          userId: INVITEE_ID,
          identityId: profileIdentityOf(INVITEE_ID),
        }),
      );
      expect(identities.resolveProfileIdentityId).toHaveBeenCalledTimes(1);
    });

    it('joinByToken seats the joiner under their profile identity, resolved once', async () => {
      await service.joinByToken('tok123', INVITEE_ID);

      expect(savedSeat()).toEqual(
        expect.objectContaining({
          userId: INVITEE_ID,
          identityId: profileIdentityOf(INVITEE_ID),
        }),
      );
      expect(identities.resolveProfileIdentityId).toHaveBeenCalledTimes(1);
    });
  });

  describe('decline', () => {
    it('marks a pending invite declined', async () => {
      await service.decline(INVITE_ID, INVITEE_ID);
      expect(invites.update).toHaveBeenCalledWith(
        { id: INVITE_ID, status: GroupInviteStatus.Pending },
        { status: GroupInviteStatus.Declined, respondedAt: expect.any(Date) },
      );
    });

    it("refuses INVITE_NOT_FOUND for someone else's invite", async () => {
      invites.findOne.mockResolvedValue(pendingInvite({ inviteeId: 'nope' }));
      await expect(
        service.decline(INVITE_ID, INVITEE_ID),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: INVITE_NOT_FOUND_CODE }),
      });
    });
  });

  describe('revoke', () => {
    it('lets an admin revoke a pending invite', async () => {
      participants.findOne.mockResolvedValue({
        role: ConversationRole.Admin,
        leftAt: null,
      });
      await service.revoke(CONVERSATION_ID, INVITE_ID, INVITER_ID);
      expect(invites.update).toHaveBeenCalledWith(
        { id: INVITE_ID, status: GroupInviteStatus.Pending },
        { status: GroupInviteStatus.Revoked, respondedAt: expect.any(Date) },
      );
    });

    it('refuses a plain member, coded like every other refusal (item 8)', async () => {
      participants.findOne.mockResolvedValue({
        role: ConversationRole.Member,
        leftAt: null,
      });
      await expect(
        service.revoke(CONVERSATION_ID, INVITE_ID, INVITEE_ID),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: GROUP_ROLE_REQUIRED_CODE }),
      });
      expect(invites.update).not.toHaveBeenCalled();
    });

    it('refuses GROUP_DISSOLVED even for an admin (item 8)', async () => {
      participants.findOne.mockResolvedValue({
        role: ConversationRole.Admin,
        leftAt: null,
      });
      conversations.findOne.mockResolvedValue({
        ...activeGroup(),
        dissolvedAt: new Date('2026-03-01T00:00:00.000Z'),
      });
      await expect(
        service.revoke(CONVERSATION_ID, INVITE_ID, INVITER_ID),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: GROUP_DISSOLVED_CODE }),
      });
      expect(invites.update).not.toHaveBeenCalled();
    });
  });

  describe('previewByToken / joinByToken', () => {
    it('404s INVITE_LINK_INVALID for an unknown token', async () => {
      conversations.findOne.mockResolvedValue(null);
      await expect(
        service.previewByToken('bad-token', INVITEE_ID),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: INVITE_LINK_INVALID_CODE }),
      });
    });

    it('404s INVITE_LINK_INVALID for a dissolved group', async () => {
      conversations.findOne.mockResolvedValue({
        ...activeGroup(),
        dissolvedAt: new Date(),
      });
      await expect(
        service.joinByToken('tok123', INVITEE_ID),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: INVITE_LINK_INVALID_CODE }),
      });
    });

    it('is idempotent for an already-active member, and answers any pending invite for that group', async () => {
      participants.findOne.mockResolvedValue({ leftAt: null });
      const result = await service.joinByToken('tok123', INVITEE_ID);
      expect(result).toBeDefined();
      expect(dataSource.transaction).not.toHaveBeenCalled();
      // Item 4: a pending invite for a group the caller is already active in
      // must not keep showing on the Requests tab or block a future re-invite.
      expect(invites.update).toHaveBeenCalledWith(
        {
          conversationId: CONVERSATION_ID,
          inviteeId: INVITEE_ID,
          status: GroupInviteStatus.Pending,
        },
        { status: GroupInviteStatus.Accepted, respondedAt: expect.any(Date) },
      );
    });

    it('refuses REMOVED_FROM_GROUP for a row an owner/admin removed', async () => {
      participants.findOne.mockResolvedValue({
        leftAt: new Date(),
        removedBy: INVITER_ID,
        removedAt: new Date(),
      });
      await expect(
        service.joinByToken('tok123', INVITEE_ID),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: REMOVED_FROM_GROUP_CODE }),
      });
    });

    it('reactivates a voluntarily-left row and posts a member_joined(link) pill', async () => {
      participants.findOne.mockResolvedValue({
        id: 'p-old',
        clearedAt: null,
        leftAt: new Date('2026-01-02T00:00:00.000Z'),
        removedBy: null,
        removedAt: null,
      });

      await service.joinByToken('tok123', INVITEE_ID);

      expect(manager.update).toHaveBeenCalledWith(
        ConversationParticipant,
        { id: 'p-old' },
        expect.objectContaining({ leftAt: null, removedAt: null }),
      );
      const [pillCall] = manager.save.mock.calls.filter(
        ([entity]: [{ systemEvent?: unknown }]) => entity.systemEvent,
      );
      if (!pillCall) {
        throw new Error('expected a system pill to be saved');
      }
      const pillEntity = pillCall[0] as {
        systemEvent: { type: string; value: string };
      };
      expect(pillEntity.systemEvent).toEqual({
        type: 'member_joined',
        actorId: INVITEE_ID,
        value: 'link',
      });
    });

    // Item 4: a pending invite alongside the link (e.g. an owner both
    // invited someone AND shared the link) is answered by the join too.
    it('marks any pending invite for this (conversation, invitee) accepted on link join', async () => {
      await service.joinByToken('tok123', INVITEE_ID);

      expect(manager.update).toHaveBeenCalledWith(
        GroupInvite,
        {
          conversationId: CONVERSATION_ID,
          inviteeId: INVITEE_ID,
          status: GroupInviteStatus.Pending,
        },
        { status: GroupInviteStatus.Accepted, respondedAt: expect.any(Date) },
      );
    });

    // ENG-239: same in-transaction re-check as `accept`.
    it('refuses GROUP_FULL from the in-transaction re-check even when the pre-check passed', async () => {
      manager.count.mockResolvedValueOnce(256);

      await expect(
        service.joinByToken('tok123', INVITEE_ID),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(manager.findOne).toHaveBeenCalledWith(
        Conversation,
        expect.objectContaining({
          where: { id: CONVERSATION_ID },
          lock: { mode: 'pessimistic_write' },
        }),
      );
    });

    // Item 5: a removed member or a member blocked by everyone gets the
    // SAME indistinguishable 404 the preview gives an unknown token.
    it('404s INVITE_LINK_INVALID (not REMOVED_FROM_GROUP) for a removed caller previewing the group', async () => {
      participants.findOne.mockResolvedValue({
        leftAt: new Date(),
        removedAt: new Date(),
      });

      await expect(
        service.previewByToken('tok123', INVITEE_ID),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: INVITE_LINK_INVALID_CODE }),
      });
    });

    it('404s INVITE_LINK_INVALID (not GROUP_ADD_REFUSED) previewing a group blocked either way', async () => {
      blockFilter.blockedAgainstAnyOf.mockResolvedValue(new Set([INVITEE_ID]));

      await expect(
        service.previewByToken('tok123', INVITEE_ID),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: INVITE_LINK_INVALID_CODE }),
      });
    });

    it('previews successfully for a caller with no removal or block', async () => {
      const result = await service.previewByToken('tok123', INVITEE_ID);
      expect(result).toMatchObject({
        conversationId: CONVERSATION_ID,
        title: 'Book club',
      });
    });
  });

  describe('listMyInvites', () => {
    it('returns a bare array (never a wrapper object)', async () => {
      invites.find.mockResolvedValue([pendingInvite()]);
      conversations.find.mockResolvedValue([activeGroup()]);

      const result = await service.listMyInvites(INVITEE_ID);

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: INVITE_ID,
        conversationId: CONVERSATION_ID,
        title: 'Book club',
      });
    });

    // Item 4 (belt-and-braces): a pending row a `member_joined`/accept write
    // failed to answer must not keep showing an invite to a group the caller
    // is already an active member of.
    it('drops a pending invite whose conversation the caller is already an active member of', async () => {
      invites.find.mockResolvedValue([pendingInvite()]);
      conversations.find.mockResolvedValue([activeGroup()]);
      participants.find.mockResolvedValue([
        { conversationId: CONVERSATION_ID },
      ]);

      const result = await service.listMyInvites(INVITEE_ID);

      expect(result).toEqual([]);
    });
  });
});
