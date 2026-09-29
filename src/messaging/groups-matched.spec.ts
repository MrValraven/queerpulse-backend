import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, Repository } from 'typeorm';
import { ConnectionsService } from '../connections/connections.service';
import { BlockFilterService } from '../social/block-filter.service';
import { GroupsService, MATCHED_GROUP_LOCKED_CODE } from './groups.service';
import { MessagingCoreService } from './messaging-core.service';
import {
  ConversationParticipant,
  ConversationRole,
} from './entities/conversation-participant.entity';
import { Conversation, ConversationKind } from './entities/conversation.entity';
import { GroupInvite, GroupInviteStatus } from './entities/group-invite.entity';
import { GroupInvitesService } from './group-invites.service';
import { Message } from './entities/message.entity';
import { Profile } from '../users/entities/profile.entity';
import {
  CONVERSATION_CREATED,
  CONVERSATION_MEMBERSHIP_REVOKED,
  GROUP_MEMBERS_ADDED,
  MATCHED_GROUP_MEMBER_LEFT,
} from './messaging.events';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';

// Go together: chats formed for matched groups. The house account owns each
// one; members can leave, and every member route that would add, invite,
// rename, restructure or dissolve refuses with `MATCHED_GROUP_LOCKED`.
describe('GroupsService matched groups', () => {
  const HOUSE_ID = '20000000-0000-4000-8000-000000000001';
  const MEMBER_A_ID = '20000000-0000-4000-8000-000000000002';
  const MEMBER_B_ID = '20000000-0000-4000-8000-000000000003';
  const MEMBER_C_ID = '20000000-0000-4000-8000-000000000004';
  const MEMBER_D_ID = '20000000-0000-4000-8000-000000000005';
  const CONVERSATION_ID = 'matched-conversation-1';
  const EVENT_MATCH_GROUP_ID = 'group-1';

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
    query: jest.Mock;
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

  const profileIdentityOf = (userId: string): string =>
    `profile-identity-of-${userId}`;

  /** An active matched group, owned by the house account. */
  const matchedGroup = (overrides: Partial<Conversation> = {}): Conversation =>
    ({
      id: CONVERSATION_ID,
      kind: ConversationKind.Group,
      title: 'Pride picnic',
      avatarUrl: null,
      description: 'Meet at the kiosk',
      inviteToken: null,
      dissolvedAt: null,
      eventMatchGroupId: EVENT_MATCH_GROUP_ID,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      ...overrides,
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

  /** Every `SystemEvent` saved through the transaction manager, in order. */
  const savedSystemEvents = (): { type: string; targetId?: string }[] =>
    (manager.save.mock.calls as [unknown][])
      .map(
        ([entity]) =>
          (entity as { systemEvent?: { type: string; targetId?: string } })
            .systemEvent,
      )
      .filter(
        (systemEvent): systemEvent is { type: string; targetId?: string } =>
          systemEvent !== undefined,
      );

  const emittedEventNames = (): string[] =>
    (eventEmitter.emit.mock.calls as [string, unknown][]).map(
      ([eventName]) => eventName,
    );

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
      findOne: jest.fn().mockResolvedValue({ id: CONVERSATION_ID }),
      count: jest.fn().mockResolvedValue(0),
      // PRD-400: `readGroupJoinHistoryFloor`'s clock reading for a new seat.
      query: jest
        .fn()
        .mockResolvedValue([
          { floorInstant: new Date('2026-01-31T23:59:59.999Z') },
        ]),
    };
    dataSource = {
      transaction: jest.fn(
        async (callback: (transactionManager: typeof manager) => unknown) =>
          callback(manager),
      ),
    };
    conversations = {
      findOne: jest.fn().mockResolvedValue(matchedGroup()),
      save: jest.fn((convo: unknown) => Promise.resolve(convo)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    participants = {
      find: jest
        .fn()
        .mockResolvedValue([
          participantRow({ userId: HOUSE_ID, role: ConversationRole.Owner }),
        ]),
      findOne: jest.fn(),
      // `broadcastPill`'s post-pill unarchive step
      // (`.update().set().where().andWhere().execute()`).
      createQueryBuilder: jest.fn(() => {
        const queryBuilder: Record<string, jest.Mock> = {};
        const returnSelf = (): typeof queryBuilder => queryBuilder;
        queryBuilder.update = jest.fn(returnSelf);
        queryBuilder.set = jest.fn(returnSelf);
        queryBuilder.where = jest.fn(returnSelf);
        queryBuilder.andWhere = jest.fn(returnSelf);
        queryBuilder.execute = jest.fn().mockResolvedValue({});
        return queryBuilder;
      }),
    };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    core = {
      requireParticipant: jest
        .fn()
        .mockResolvedValue(
          participantRow({ userId: HOUSE_ID, role: ConversationRole.Owner }),
        ),
      lastMessagesByConversation: jest.fn().mockResolvedValue(new Map()),
      unreadCountsByConversation: jest.fn().mockResolvedValue(new Map()),
      buildMemberSummaries: jest.fn().mockReturnValue([]),
      buildMemberPreview: jest.fn().mockReturnValue([]),
      reactionSummariesByMessage: jest.fn().mockResolvedValue(new Map()),
      buildLastMessagePreview: jest.fn().mockReturnValue(null),
      groupCapabilities: jest.fn().mockReturnValue({}),
      hasUnreadMentionByConversation: jest.fn().mockResolvedValue(new Map()),
      buildPostResult: jest
        .fn()
        .mockResolvedValue({ view: {}, response: { systemEvent: null } }),
      assertInitiatorIsProfile: jest.fn().mockResolvedValue(undefined),
    };
    eventEmitter = { emit: jest.fn() };
    connectionsService = {
      acceptedConnectionsAmong: jest.fn().mockResolvedValue(new Set()),
    };
    blockFilter = {
      blockedAgainstAnyOf: jest.fn().mockResolvedValue(new Set<string>()),
    };
    mediaCropService = { getMany: jest.fn().mockResolvedValue(new Map()) };
    preferencesService = {
      getMessagingPrivacyForUsers: jest.fn().mockResolvedValue(new Map()),
      getGroupAddPolicyForUsers: jest.fn().mockResolvedValue(new Map()),
    };
    groupInvites = { find: jest.fn().mockResolvedValue([]) };
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

  it('seats the owner and every member without checking connections or group-add policy', async () => {
    manager.save.mockImplementationOnce((entity: unknown) =>
      Promise.resolve({
        id: CONVERSATION_ID,
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
        ...(entity as object),
      }),
    );

    const result = await service.createMatchedGroup({
      ownerUserId: HOUSE_ID,
      memberUserIds: [MEMBER_A_ID, MEMBER_B_ID, MEMBER_C_ID, MEMBER_D_ID],
      title: 'Pride picnic',
      description: 'Meet at the kiosk',
      eventMatchGroupId: EVENT_MATCH_GROUP_ID,
    });

    expect(result).toEqual({ conversationId: CONVERSATION_ID });
    expect(connectionsService.acceptedConnectionsAmong).not.toHaveBeenCalled();
    expect(preferencesService.getGroupAddPolicyForUsers).not.toHaveBeenCalled();
    expect(blockFilter.blockedAgainstAnyOf).not.toHaveBeenCalled();

    const conversationCreates = (
      manager.create.mock.calls as [unknown, Record<string, unknown>][]
    ).filter(([entity]) => entity === Conversation);
    expect(conversationCreates).toHaveLength(1);
    const [conversationCreate] = conversationCreates;
    expect(conversationCreate?.[1]).toMatchObject({
      kind: ConversationKind.Group,
      title: 'Pride picnic',
      createdBy: HOUSE_ID,
      description: 'Meet at the kiosk',
      eventMatchGroupId: EVENT_MATCH_GROUP_ID,
      // PRD-423: the durable marker that outlives the group row.
      isGoTogetherChat: true,
    });

    const seats = (
      manager.create.mock.calls as [
        unknown,
        { userId: string; role: ConversationRole; identityId: string },
      ][]
    )
      .filter(([entity]) => entity === ConversationParticipant)
      .map(([, seat]) => ({
        userId: seat.userId,
        role: seat.role,
        identityId: seat.identityId,
      }));
    expect(seats).toEqual([
      {
        userId: HOUSE_ID,
        role: ConversationRole.Owner,
        identityId: profileIdentityOf(HOUSE_ID),
      },
      ...[MEMBER_A_ID, MEMBER_B_ID, MEMBER_C_ID, MEMBER_D_ID].map(
        (memberUserId) => ({
          userId: memberUserId,
          role: ConversationRole.Member,
          identityId: profileIdentityOf(memberUserId),
        }),
      ),
    ]);

    expect(savedSystemEvents()).toEqual([
      { type: 'group_created', actorId: HOUSE_ID },
    ]);
    expect(eventEmitter.emit).toHaveBeenCalledWith(CONVERSATION_CREATED, {
      conversationId: CONVERSATION_ID,
      memberUserIds: [
        HOUSE_ID,
        MEMBER_A_ID,
        MEMBER_B_ID,
        MEMBER_C_ID,
        MEMBER_D_ID,
      ],
    });
    expect(emittedEventNames()).not.toContain(GROUP_MEMBERS_ADDED);
  });

  it('refuses addMembers on a matched group with MATCHED_GROUP_LOCKED', async () => {
    await expect(
      service.addMembers(CONVERSATION_ID, HOUSE_ID, ['someone']),
    ).rejects.toMatchObject({
      response: { code: MATCHED_GROUP_LOCKED_CODE },
    });
    await expect(
      service.addMembers(CONVERSATION_ID, HOUSE_ID, ['someone']),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(profiles.find).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('refuses minting an invite link on a matched group', async () => {
    await expect(
      service.createOrRotateInviteLink(CONVERSATION_ID, HOUSE_ID),
    ).rejects.toMatchObject({
      response: { code: MATCHED_GROUP_LOCKED_CODE },
    });
    expect(conversations.update).not.toHaveBeenCalled();
  });

  it('refuses the member dissolve route on a matched group', async () => {
    await expect(
      service.dissolveGroup(CONVERSATION_ID, HOUSE_ID),
    ).rejects.toMatchObject({
      response: { code: MATCHED_GROUP_LOCKED_CODE },
    });
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('still lets a member leave a matched group', async () => {
    core.requireParticipant.mockResolvedValue(
      participantRow({ userId: MEMBER_A_ID, role: ConversationRole.Member }),
    );

    await expect(
      service.leaveGroup(CONVERSATION_ID, MEMBER_A_ID),
    ).resolves.toEqual({ ok: true });

    expect(manager.update).toHaveBeenCalledWith(
      ConversationParticipant,
      { id: `p-${MEMBER_A_ID}` },
      { leftAt: expect.any(Date) },
    );
    expect(savedSystemEvents()).toEqual([
      { type: 'member_left', actorId: MEMBER_A_ID },
    ]);
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      CONVERSATION_MEMBERSHIP_REVOKED,
      { conversationId: CONVERSATION_ID, userIds: [MEMBER_A_ID] },
    );
    // Go together withdraws the member's entry for this group.
    expect(eventEmitter.emit).toHaveBeenCalledWith(MATCHED_GROUP_MEMBER_LEFT, {
      conversationId: CONVERSATION_ID,
      eventMatchGroupId: EVENT_MATCH_GROUP_ID,
      userId: MEMBER_A_ID,
    });
  });

  it('announces no matched leave when Go together itself takes the member out', async () => {
    core.requireParticipant.mockResolvedValue(
      participantRow({ userId: MEMBER_A_ID, role: ConversationRole.Member }),
    );

    await expect(
      service.leaveGroup(CONVERSATION_ID, MEMBER_A_ID, {
        isGoTogetherRemoval: true,
      }),
    ).resolves.toEqual({ ok: true });

    expect(savedSystemEvents()).toEqual([
      { type: 'member_left', actorId: MEMBER_A_ID },
    ]);
    expect(emittedEventNames()).toContain(CONVERSATION_MEMBERSHIP_REVOKED);
    expect(emittedEventNames()).not.toContain(MATCHED_GROUP_MEMBER_LEFT);
  });

  it('announces no matched leave for a member who already left', async () => {
    core.requireParticipant.mockResolvedValue(
      participantRow({
        userId: MEMBER_A_ID,
        role: ConversationRole.Member,
        leftAt: new Date('2026-02-01T00:00:00.000Z'),
      }),
    );

    await expect(
      service.leaveGroup(CONVERSATION_ID, MEMBER_A_ID),
    ).resolves.toEqual({ ok: true });

    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(emittedEventNames()).not.toContain(MATCHED_GROUP_MEMBER_LEFT);
  });

  it('announces no matched leave for an ordinary group', async () => {
    conversations.findOne.mockResolvedValue(
      matchedGroup({ eventMatchGroupId: null }),
    );
    core.requireParticipant.mockResolvedValue(
      participantRow({ userId: MEMBER_A_ID, role: ConversationRole.Member }),
    );

    await service.leaveGroup(CONVERSATION_ID, MEMBER_A_ID);

    expect(emittedEventNames()).toContain(CONVERSATION_MEMBERSHIP_REVOKED);
    expect(emittedEventNames()).not.toContain(MATCHED_GROUP_MEMBER_LEFT);
  });

  it('seats late joiners through addMatchedMembers, reviving a departed row and skipping active members', async () => {
    const departedAt = new Date('2026-01-15T00:00:00.000Z');
    participants.find.mockResolvedValue([
      participantRow({ userId: MEMBER_A_ID }),
      participantRow({ userId: MEMBER_B_ID, leftAt: departedAt }),
    ]);

    await service.addMatchedMembers(CONVERSATION_ID, HOUSE_ID, [
      MEMBER_A_ID,
      MEMBER_B_ID,
      MEMBER_C_ID,
    ]);

    expect(manager.update).toHaveBeenCalledWith(
      ConversationParticipant,
      { id: `p-${MEMBER_B_ID}` },
      expect.objectContaining({
        leftAt: null,
        clearedAt: departedAt,
        role: ConversationRole.Member,
      }),
    );
    const newSeats = (
      manager.create.mock.calls as [unknown, { userId: string }][]
    )
      .filter(([entity]) => entity === ConversationParticipant)
      .map(([, seat]) => seat.userId);
    expect(newSeats).toEqual([MEMBER_C_ID]);
    expect(savedSystemEvents()).toEqual([
      { type: 'member_added', actorId: HOUSE_ID, targetId: MEMBER_B_ID },
      { type: 'member_added', actorId: HOUSE_ID, targetId: MEMBER_C_ID },
    ]);
    expect(eventEmitter.emit).toHaveBeenCalledWith(CONVERSATION_CREATED, {
      conversationId: CONVERSATION_ID,
      memberUserIds: [MEMBER_B_ID, MEMBER_C_ID],
    });
    expect(emittedEventNames()).not.toContain(GROUP_MEMBERS_ADDED);
    expect(connectionsService.acceptedConnectionsAmong).not.toHaveBeenCalled();
    expect(preferencesService.getGroupAddPolicyForUsers).not.toHaveBeenCalled();
  });

  // PRD-400: a late joiner reads the matched group from their join onward;
  // a returning member keeps the resume floor the re-add path always used.
  it('floors a late joiner seat at its join and leaves a revived seat on its resume floor', async () => {
    const departedAt = new Date('2026-01-15T00:00:00.000Z');
    const joinFloor = new Date('2026-01-31T23:59:59.999Z');
    participants.find.mockResolvedValue([
      participantRow({ userId: MEMBER_B_ID, leftAt: departedAt }),
    ]);

    await service.addMatchedMembers(CONVERSATION_ID, HOUSE_ID, [
      MEMBER_B_ID,
      MEMBER_C_ID,
    ]);

    const newSeats = (
      manager.create.mock.calls as [
        unknown,
        { userId: string; clearedAt?: Date; historyFloorAt?: Date },
      ][]
    )
      .filter(([entity]) => entity === ConversationParticipant)
      .map(([, seat]) => seat);
    expect(newSeats).toEqual([
      expect.objectContaining({
        userId: MEMBER_C_ID,
        clearedAt: joinFloor,
        historyFloorAt: joinFloor,
      }),
    ]);
    const revivedWrite = (
      manager.update.mock.calls as [unknown, unknown, Record<string, unknown>][]
    ).find(([entity]) => entity === ConversationParticipant);
    expect(revivedWrite?.[2]).toEqual(
      expect.objectContaining({ clearedAt: departedAt }),
    );
    expect(revivedWrite?.[2]).not.toHaveProperty('historyFloorAt');
  });

  it('refuses addMatchedMembers from anyone but the Owner seat', async () => {
    core.requireParticipant.mockResolvedValue(
      participantRow({ userId: MEMBER_A_ID, role: ConversationRole.Member }),
    );

    await expect(
      service.addMatchedMembers(CONVERSATION_ID, MEMBER_A_ID, [MEMBER_C_ID]),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('refuses addMatchedMembers on a group that Go together did not form', async () => {
    conversations.findOne.mockResolvedValue(
      matchedGroup({ eventMatchGroupId: null }),
    );

    await expect(
      service.addMatchedMembers(CONVERSATION_ID, HOUSE_ID, [MEMBER_C_ID]),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(core.requireParticipant).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('refuses addMatchedMembers on a dissolved matched group', async () => {
    conversations.findOne.mockResolvedValue(
      matchedGroup({ dissolvedAt: new Date('2026-02-02T00:00:00.000Z') }),
    );

    await expect(
      service.addMatchedMembers(CONVERSATION_ID, HOUSE_ID, [MEMBER_C_ID]),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(participants.find).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('dissolves a matched group when asked by its owner through dissolveMatchedGroup', async () => {
    manager.find.mockResolvedValueOnce([
      { userId: HOUSE_ID },
      { userId: MEMBER_A_ID },
    ]);

    await service.dissolveMatchedGroup(CONVERSATION_ID, HOUSE_ID);

    expect(savedSystemEvents()).toEqual([
      { type: 'group_dissolved', actorId: HOUSE_ID },
    ]);
    expect(manager.update).toHaveBeenCalledWith(
      Conversation,
      { id: CONVERSATION_ID },
      {
        dissolvedAt: expect.any(Date),
        inviteToken: null,
        inviteTokenExpiresAt: null,
      },
    );
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      CONVERSATION_MEMBERSHIP_REVOKED,
      { conversationId: CONVERSATION_ID, userIds: [HOUSE_ID, MEMBER_A_ID] },
    );
  });

  it('treats dissolveMatchedGroup on an already dissolved group as done', async () => {
    conversations.findOne.mockResolvedValue(
      matchedGroup({ dissolvedAt: new Date('2026-02-02T00:00:00.000Z') }),
    );
    core.requireParticipant.mockResolvedValue(
      participantRow({
        userId: HOUSE_ID,
        role: ConversationRole.Owner,
        leftAt: new Date('2026-02-02T00:00:00.001Z'),
      }),
    );

    await expect(
      service.dissolveMatchedGroup(CONVERSATION_ID, HOUSE_ID),
    ).resolves.toBeUndefined();
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });
});

// Defence in depth: no invite or link should ever exist for a matched group,
// and if one does, accepting it or joining through it is refused before any
// seat is written. Both refusals happen ahead of every roster read, so only
// the invite and conversation lookups need real mocks.
describe('GroupInvitesService matched groups', () => {
  const INVITEE_ID = '30000000-0000-4000-8000-000000000001';
  const INVITER_ID = '30000000-0000-4000-8000-000000000002';
  const CONVERSATION_ID = 'matched-conversation-1';
  const INVITE_ID = 'invite-1';

  let service: GroupInvitesService;
  let invites: { findOne: jest.Mock; update: jest.Mock };
  let conversations: { findOne: jest.Mock };
  let participants: { findOne: jest.Mock; find: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  const matchedGroup = (): Conversation =>
    ({
      id: CONVERSATION_ID,
      kind: ConversationKind.Group,
      title: 'Pride picnic',
      avatarUrl: null,
      description: 'Meet at the kiosk',
      inviteToken: 'stray-token',
      dissolvedAt: null,
      eventMatchGroupId: 'group-1',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    }) as unknown as Conversation;

  const pendingInvite = (): GroupInvite => ({
    id: INVITE_ID,
    conversationId: CONVERSATION_ID,
    inviteeId: INVITEE_ID,
    inviterId: INVITER_ID,
    status: GroupInviteStatus.Pending,
    createdAt: new Date('2026-01-05T00:00:00.000Z'),
    respondedAt: null,
  });

  beforeEach(() => {
    invites = {
      findOne: jest.fn().mockResolvedValue(pendingInvite()),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    conversations = {
      findOne: jest.fn().mockResolvedValue(matchedGroup()),
    };
    participants = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([{ userId: INVITER_ID }]),
    };
    dataSource = { transaction: jest.fn() };

    service = new GroupInvitesService(
      invites as unknown as Repository<GroupInvite>,
      conversations as unknown as Repository<Conversation>,
      participants as unknown as Repository<ConversationParticipant>,
      {} as unknown as Repository<Profile>,
      {} as unknown as MessagingCoreService,
      {} as unknown as BlockFilterService,
      dataSource as unknown as DataSource,
      { emit: jest.fn() } as unknown as EventEmitter2,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  it('refuses accepting an invite into a matched group with MATCHED_GROUP_LOCKED', async () => {
    await expect(service.accept(INVITE_ID, INVITEE_ID)).rejects.toMatchObject({
      response: { code: MATCHED_GROUP_LOCKED_CODE },
    });
    expect(participants.find).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(invites.update).not.toHaveBeenCalled();
  });

  it('refuses joining a matched group by link with MATCHED_GROUP_LOCKED', async () => {
    await expect(
      service.joinByToken('stray-token', INVITEE_ID),
    ).rejects.toMatchObject({
      response: { code: MATCHED_GROUP_LOCKED_CODE },
    });
    expect(participants.findOne).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });
});
