import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { toImageUrl } from '../common/image-url';
import { BlockFilterService } from '../social/block-filter.service';
import { ConnectionsService } from '../connections/connections.service';
import { Profile } from '../users/entities/profile.entity';
import {
  ConversationParticipant,
  ConversationRole,
} from './entities/conversation-participant.entity';
import { Conversation, ConversationKind } from './entities/conversation.entity';
import { Message, MessageKind, SystemEvent } from './entities/message.entity';
import { ConversationResponse } from './message-response';
import {
  CONVERSATION_CREATED,
  ConversationCreatedEvent,
} from './messaging.events';
import { MessagingCoreService } from './messaging-core.service';

/**
 * Plain-text `body` for each kind of system message. This is only a FALLBACK for
 * consumers that don't render the structured `systemEvent` (push previews,
 * search, the inbox preview in a non-group-aware client) — the actual timeline
 * pill is built by the CLIENT from `systemEvent`, bilingually. English by design
 * (server-stored content, like member/message text) — see the i18n note in
 * `catalogs/en/messages.ts`.
 */
const SYSTEM_EVENT_FALLBACK: Record<SystemEvent['type'], string> = {
  group_created: 'created the group',
  member_added: 'added a member',
  member_removed: 'removed a member',
  member_left: 'left the group',
  group_renamed: 'renamed the group',
};

/**
 * Group role precedence (lower = more powerful). Used by the server-side role
 * gate (`requireGroupRole`) and owner-succession so a single comparison covers
 * "owner > admin > member". NEVER derived from the client — the caller's role is
 * always re-read from their participant row.
 */
const ROLE_RANK: Record<ConversationRole, number> = {
  [ConversationRole.Owner]: 0,
  [ConversationRole.Admin]: 1,
  [ConversationRole.Member]: 2,
};

/**
 * Groups concern of the split `MessagingService`: group thread creation,
 * membership (add/remove/leave), roles, and title/avatar edits — every
 * SERVER-AUTHORITATIVE role-gated mutation, plus the system-message "pills"
 * that narrate them. DM/inbox concerns live in `ConversationsService`;
 * send/edit/delete live in `MessagesService`.
 */
@Injectable()
export class GroupsService {
  constructor(
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    @InjectRepository(ConversationParticipant)
    private readonly participants: Repository<ConversationParticipant>,
    @InjectRepository(Message)
    private readonly messages: Repository<Message>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly core: MessagingCoreService,
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
    private readonly connectionsService: ConnectionsService,
    private readonly blockFilter: BlockFilterService,
  ) {}

  /**
   * `POST /conversations/group` — create a group thread. The caller becomes its
   * `owner` participant; each resolved member joins as `member`. Members are
   * addressed by their profile HANDLE (slug — the same identifier the DM start
   * uses), resolved to user ids here. Every prospective member is gated exactly
   * like a DM: a block either way is a hard stop, and the pair must be accepted
   * connections. Seeds a `group_created` system message and fans the new group
   * to every member's socket room so their inbox refreshes live.
   */
  async createGroup(
    userId: string,
    title: string,
    memberHandles: string[],
    avatarUrl?: string,
  ): Promise<ConversationResponse> {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      throw new BadRequestException('A group needs a name');
    }
    const uniqueHandles = [
      ...new Set(memberHandles.map((handle) => handle.trim()).filter(Boolean)),
    ];
    if (!uniqueHandles.length) {
      throw new BadRequestException('A group needs at least one other member');
    }
    const profiles = await this.profiles.find({
      where: { slug: In(uniqueHandles) },
    });
    const profileByHandle = new Map(profiles.map((p) => [p.slug, p]));
    // Resolve EVERY handle first (a missing one is a hard 404) and collect the
    // distinct prospective members, silently dropping the creator if they
    // included themselves.
    const memberUserIds: string[] = [];
    for (const handle of uniqueHandles) {
      const profile = profileByHandle.get(handle);
      if (!profile) {
        throw new NotFoundException(`Member not found: ${handle}`);
      }
      if (profile.userId === userId) {
        continue;
      }
      if (!memberUserIds.includes(profile.userId)) {
        memberUserIds.push(profile.userId);
      }
    }
    if (!memberUserIds.length) {
      throw new BadRequestException('A group needs at least one other member');
    }
    // Batched block + connection gate across ALL prospective members — two
    // queries total instead of a sequential pair per handle (N+1).
    await this.assertAddableMembers(userId, memberUserIds);

    // Single transaction: the conversation, every participant, AND the opening
    // system message commit together — a throw anywhere rolls the whole group
    // back rather than leaving a group with no `group_created` pill.
    const { conversation, systemMessage } = await this.dataSource.transaction(
      async (manager) => {
        const convo = await manager.save(
          manager.create(Conversation, {
            kind: ConversationKind.Group,
            isOfficial: false,
            pairKey: null,
            title: trimmedTitle,
            avatarUrl: avatarUrl ?? null,
            createdBy: userId,
          }),
        );
        await manager.save([
          manager.create(ConversationParticipant, {
            conversationId: convo.id,
            userId,
            role: ConversationRole.Owner,
          }),
          ...memberUserIds.map((memberId) =>
            manager.create(ConversationParticipant, {
              conversationId: convo.id,
              userId: memberId,
              role: ConversationRole.Member,
            }),
          ),
        ]);
        // Seed the opening system message (actor = creator) INSIDE the txn.
        // `body` is a plain-text fallback; the client renders the structured
        // event as a centred pill.
        const systemMessage = await this.insertSystemMessage(
          manager,
          convo.id,
          {
            type: 'group_created',
            actorId: userId,
          },
        );
        return { conversation: convo, systemMessage };
      },
    );

    // Best-effort live fan-out AFTER commit — a socket relay failure must not
    // 500 a group that already committed. Broadcast the opening pill, then fan
    // the new group to each member's `user:<id>` room (they weren't in the
    // conversation room at creation, so a room-scoped `message:new` won't reach
    // them) so their inbox refetches live.
    await this.broadcastSystemMessage(systemMessage);
    this.emitBestEffort(CONVERSATION_CREATED, {
      conversationId: conversation.id,
      memberUserIds: [userId, ...memberUserIds],
    } satisfies ConversationCreatedEvent);

    return this.toGroupConversationResponse(conversation, userId);
  }

  /**
   * `POST /conversations/:id/leave` — the caller leaves a GROUP. Stamps their
   * `left_at` (KEEPING the row for history + identity resolution), seeds a
   * `member_left` system message, and broadcasts it to the room. Idempotent: a
   * repeat leave is a no-op success. Adding/removing OTHERS and role changes are
   * Phase 2 — this only covers the foundational self-leave.
   */
  async leaveGroup(
    conversationId: string,
    userId: string,
  ): Promise<{ ok: true }> {
    const participant = await this.core.requireParticipant(
      conversationId,
      userId,
    );
    const convo = await this.conversations.findOne({
      where: { id: conversationId },
    });
    if (!convo || convo.kind !== ConversationKind.Group) {
      throw new BadRequestException('This is not a group conversation');
    }
    if (participant.leftAt) {
      return { ok: true };
    }
    // One transaction for the leave + the `member_left` pill + owner succession:
    // an owner's `left_at` can no longer commit on its own and leave the group
    // ownerless (and unpromotable) if a later write throws.
    const { systemMessage, promotedSuccessor } =
      await this.dataSource.transaction(async (manager) => {
        participant.leftAt = new Date();
        await manager.save(participant);
        const systemMessage = await this.insertSystemMessage(
          manager,
          conversationId,
          { type: 'member_left', actorId: userId },
        );
        // Owner succession: an owner who leaves hands ownership to the
        // longest-standing remaining member. Participant rows carry no join
        // timestamp, so "longest-standing" is approximated deterministically —
        // an existing admin before a plain member, ties broken by participant id
        // (a stable rule, documented in group-chat.md). If nobody remains, the
        // group is left ownerless (no dissolve — matches Phase 1's "no cleanup"
        // decision).
        const promotedSuccessor =
          participant.role === ConversationRole.Owner
            ? await this.promoteSuccessorInTransaction(
                manager,
                conversationId,
                userId,
              )
            : false;
        return { systemMessage, promotedSuccessor };
      });

    // Best-effort live fan-out AFTER commit.
    await this.broadcastSystemMessage(systemMessage);
    if (promotedSuccessor) {
      await this.fanGroupRefresh(conversationId);
    }
    return { ok: true };
  }

  /**
   * `POST /conversations/:id/members` — owner/admin adds members by HANDLE. Each
   * prospective member is gated exactly like a DM/create (block either way → 403,
   * not an accepted connection of the ADDER → 403); an already-active member is
   * skipped, and a previously-removed/left member's row is REACTIVATED (role reset
   * to member, `left_at`/`cleared_at` cleared so they see history again). Posts a
   * `member_added` pill per add and fans the group to each new member's user room.
   * SERVER-AUTHORITATIVE: the caller's role is re-checked here, not trusted.
   */
  async addMembers(
    conversationId: string,
    actorUserId: string,
    memberHandles: string[],
  ): Promise<ConversationResponse> {
    const { convo } = await this.requireGroupRole(
      conversationId,
      actorUserId,
      ConversationRole.Admin,
    );
    const uniqueHandles = [
      ...new Set(memberHandles.map((handle) => handle.trim()).filter(Boolean)),
    ];
    if (!uniqueHandles.length) {
      throw new BadRequestException('Pick at least one member to add');
    }
    const profiles = await this.profiles.find({
      where: { slug: In(uniqueHandles) },
    });
    const profileByHandle = new Map(profiles.map((p) => [p.slug, p]));
    const existingRows = await this.participants.find({
      where: { conversationId },
    });
    const rowByUser = new Map(existingRows.map((row) => [row.userId, row]));
    // Resolve + validate EVERY handle up front (a missing one is a hard 404),
    // skipping the actor and already-active members. Nothing is written yet, so
    // a later invalid handle can no longer leave earlier members half-added.
    const membersToAdd: {
      profile: Profile;
      existing: ConversationParticipant | undefined;
    }[] = [];
    const addedUserIds: string[] = [];
    for (const handle of uniqueHandles) {
      const profile = profileByHandle.get(handle);
      if (!profile) {
        throw new NotFoundException(`Member not found: ${handle}`);
      }
      if (profile.userId === actorUserId) {
        continue;
      }
      const existing = rowByUser.get(profile.userId);
      if (existing && existing.leftAt == null) {
        continue; // already an active member — silently skip
      }
      if (addedUserIds.includes(profile.userId)) {
        continue; // two handles resolving to the same member — dedupe
      }
      membersToAdd.push({ profile, existing });
      addedUserIds.push(profile.userId);
    }
    if (!addedUserIds.length) {
      throw new BadRequestException('No new members to add');
    }
    // Batched block + connection gate across ALL candidates — two queries total
    // instead of a sequential pair per handle (N+1).
    await this.assertAddableMembers(actorUserId, addedUserIds);

    // Single transaction: every (re)activation/insert AND its `member_added`
    // pill commit together — a throw mid-loop no longer leaves some members
    // added with no pill / no fan-out.
    const systemMessages = await this.dataSource.transaction(
      async (manager) => {
        const pills: Message[] = [];
        for (const { profile, existing } of membersToAdd) {
          if (existing) {
            existing.leftAt = null;
            existing.role = ConversationRole.Member;
            existing.clearedAt = null;
            await manager.save(existing);
          } else {
            await manager.save(
              manager.create(ConversationParticipant, {
                conversationId,
                userId: profile.userId,
                role: ConversationRole.Member,
              }),
            );
          }
          pills.push(
            await this.insertSystemMessage(manager, conversationId, {
              type: 'member_added',
              actorId: actorUserId,
              targetId: profile.userId,
            }),
          );
        }
        return pills;
      },
    );

    // Best-effort live fan-out AFTER commit: one pill per add, then fan the group
    // to each new member's `user:<id>` room so their inbox refetches live.
    for (const systemMessage of systemMessages) {
      await this.broadcastSystemMessage(systemMessage);
    }
    this.emitBestEffort(CONVERSATION_CREATED, {
      conversationId,
      memberUserIds: addedUserIds,
    } satisfies ConversationCreatedEvent);
    return this.toGroupConversationResponse(convo, actorUserId);
  }

  /**
   * `DELETE /conversations/:id/members/:userId` — owner/admin removes a member.
   * The owner can never be removed; an admin may remove members but only the
   * owner may remove another admin. Sets the target's `left_at` (row kept for
   * history + identity), posts a `member_removed` pill (relayed to the room), and
   * fans a refetch to the removed member's user room so their client reflects the
   * departure (read-only history retained, like a voluntary leave).
   * SERVER-AUTHORITATIVE role re-check.
   *
   * The participant write and the `member_removed` pill commit in ONE
   * transaction (mirroring `leaveGroup`/`addMembers`/`createGroup`) so a crash
   * between the two can never leave a removed member with no system message, or
   * a pill with no corresponding removal.
   */
  async removeMember(
    conversationId: string,
    actorUserId: string,
    targetUserId: string,
  ): Promise<ConversationResponse> {
    const { participant: actor, convo } = await this.requireGroupRole(
      conversationId,
      actorUserId,
      ConversationRole.Admin,
    );
    if (targetUserId === actorUserId) {
      throw new BadRequestException('Use leave to remove yourself');
    }
    const target = await this.participants.findOne({
      where: { conversationId, userId: targetUserId },
    });
    if (!target || target.leftAt) {
      throw new NotFoundException('That member is not in this group');
    }
    if (target.role === ConversationRole.Owner) {
      throw new ForbiddenException('The group owner cannot be removed');
    }
    // Admins manage members; only the owner acts on other admins.
    if (
      target.role === ConversationRole.Admin &&
      actor.role !== ConversationRole.Owner
    ) {
      throw new ForbiddenException('Only the owner can remove an admin');
    }
    const systemMessage = await this.dataSource.transaction(async (manager) => {
      target.leftAt = new Date();
      await manager.save(target);
      return this.insertSystemMessage(manager, conversationId, {
        type: 'member_removed',
        actorId: actorUserId,
        targetId: targetUserId,
      });
    });
    // Best-effort live fan-out AFTER commit — matches leaveGroup/addMembers/
    // createGroup's convention.
    await this.broadcastSystemMessage(systemMessage);
    this.eventEmitter.emit(CONVERSATION_CREATED, {
      conversationId,
      memberUserIds: [targetUserId],
    } satisfies ConversationCreatedEvent);
    return this.toGroupConversationResponse(convo, actorUserId);
  }

  /**
   * `PATCH /conversations/:id/members/:userId/role` — OWNER ONLY. Promotes a
   * member→admin or demotes an admin→member (the `owner` role can't be assigned
   * here — succession is separate). Quiet (no pill); fans a refetch so every
   * member's role badges + can-flags update live. SERVER-AUTHORITATIVE.
   */
  async changeMemberRole(
    conversationId: string,
    actorUserId: string,
    targetUserId: string,
    role: ConversationRole,
  ): Promise<ConversationResponse> {
    const { convo } = await this.requireGroupRole(
      conversationId,
      actorUserId,
      ConversationRole.Owner,
    );
    if (role !== ConversationRole.Admin && role !== ConversationRole.Member) {
      throw new BadRequestException('Role must be admin or member');
    }
    if (targetUserId === actorUserId) {
      throw new BadRequestException('You cannot change your own role');
    }
    const target = await this.participants.findOne({
      where: { conversationId, userId: targetUserId },
    });
    if (!target || target.leftAt) {
      throw new NotFoundException('That member is not in this group');
    }
    if (target.role === ConversationRole.Owner) {
      throw new ForbiddenException('The owner role cannot be changed here');
    }
    if (target.role !== role) {
      target.role = role;
      await this.participants.save(target);
      await this.fanGroupRefresh(conversationId);
    }
    return this.toGroupConversationResponse(convo, actorUserId);
  }

  /**
   * `PATCH /conversations/:id` (title/avatar) — owner/admin edits the group's
   * name and/or photo. A title change posts a `group_renamed` pill (relayed to
   * the room); an avatar-only change fans a quiet refetch. `avatarUrl` reuses the
   * storage-key plumbing already threaded end-to-end (no new upload pipeline is
   * built here — see the group-chat note). SERVER-AUTHORITATIVE role re-check.
   */
  async updateGroup(
    conversationId: string,
    actorUserId: string,
    changes: { title?: string; avatarUrl?: string | null },
  ): Promise<ConversationResponse> {
    const { convo } = await this.requireGroupRole(
      conversationId,
      actorUserId,
      ConversationRole.Admin,
    );
    let renamed = false;
    if (changes.title !== undefined) {
      const trimmed = changes.title.trim();
      if (!trimmed) {
        throw new BadRequestException('A group needs a name');
      }
      if (trimmed !== convo.title) {
        convo.title = trimmed;
        renamed = true;
      }
    }
    let avatarChanged = false;
    if (changes.avatarUrl !== undefined) {
      const next = changes.avatarUrl || null;
      if (next !== convo.avatarUrl) {
        convo.avatarUrl = next;
        avatarChanged = true;
      }
    }
    if (renamed || avatarChanged) {
      await this.conversations.save(convo);
    }
    if (renamed) {
      await this.postSystemMessage(conversationId, {
        type: 'group_renamed',
        actorId: actorUserId,
        value: convo.title ?? undefined,
      });
    } else if (avatarChanged) {
      await this.fanGroupRefresh(conversationId);
    }
    return this.toGroupConversationResponse(convo, actorUserId);
  }

  /**
   * Server-authoritative group role gate. Loads the caller's participant row +
   * the conversation, asserts it's a group they still belong to (not left), and
   * that their role meets `minRole` in owner > admin > member order. EVERY
   * management mutation calls this first; the DTO's can-flags are never trusted.
   */
  private async requireGroupRole(
    conversationId: string,
    userId: string,
    minRole: ConversationRole,
  ): Promise<{ participant: ConversationParticipant; convo: Conversation }> {
    const participant = await this.core.requireParticipant(
      conversationId,
      userId,
    );
    const convo = await this.conversations.findOne({
      where: { id: conversationId },
    });
    if (!convo || convo.kind !== ConversationKind.Group) {
      throw new BadRequestException('This is not a group conversation');
    }
    if (participant.leftAt) {
      throw new ForbiddenException('You have left this group');
    }
    if (ROLE_RANK[participant.role] > ROLE_RANK[minRole]) {
      throw new ForbiddenException('You do not have permission to do that');
    }
    return { participant, convo };
  }

  /**
   * Promote the successor when an owner leaves, INSIDE the caller's transaction:
   * the highest-ranked remaining active member (an existing admin before a plain
   * member), ties broken deterministically by participant id. Returns whether a
   * successor was promoted so the caller can fan a quiet refetch AFTER commit;
   * `false` (nobody remains) leaves the group ownerless (no dissolve).
   */
  private async promoteSuccessorInTransaction(
    manager: EntityManager,
    conversationId: string,
    leavingUserId: string,
  ): Promise<boolean> {
    const rows = await manager.find(ConversationParticipant, {
      where: { conversationId },
    });
    const [successor] = rows
      .filter((row) => row.leftAt == null && row.userId !== leavingUserId)
      .sort(
        (a, b) =>
          ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.id.localeCompare(b.id),
      );
    if (!successor) {
      return false;
    }
    successor.role = ConversationRole.Owner;
    await manager.save(successor);
    return true;
  }

  /**
   * Fan a `conversation:new` (inbox refetch) to every ACTIVE member's user room —
   * for group mutations that post no system message (role change, avatar-only
   * edit, succession) so every member's roster/can-flags/photo refresh live.
   */
  private async fanGroupRefresh(conversationId: string): Promise<void> {
    const rows = await this.participants.find({ where: { conversationId } });
    const memberUserIds = rows
      .filter((row) => row.leftAt == null)
      .map((row) => row.userId);
    if (!memberUserIds.length) {
      return;
    }
    this.emitBestEffort(CONVERSATION_CREATED, {
      conversationId,
      memberUserIds,
    } satisfies ConversationCreatedEvent);
  }

  /**
   * Persist a `system` message and broadcast it (via `buildPostResult` →
   * MESSAGE_CREATED → the gateway's `message:new`). The event's `actorId` is the
   * message's sender, so the actor's profile is already batch-loaded when the
   * DTO resolves the event to display names. `body` is a plain-text fallback for
   * consumers that don't understand the structured event.
   */
  private async postSystemMessage(
    conversationId: string,
    event: SystemEvent,
  ): Promise<void> {
    const saved = await this.insertSystemMessage(
      this.messages.manager,
      conversationId,
      event,
    );
    await this.core.buildPostResult(saved, event.actorId, true);
  }

  /**
   * Persist a `system` message row using the supplied `manager` — the pure
   * INSERT with no broadcast, so it can run INSIDE a transaction (createGroup /
   * leaveGroup / addMembers / removeMember) and have its MESSAGE_CREATED
   * fan-out deferred to after commit via `broadcastSystemMessage`. `body` is a
   * plain-text fallback for consumers that don't understand the structured
   * event.
   */
  private insertSystemMessage(
    manager: EntityManager,
    conversationId: string,
    event: SystemEvent,
  ): Promise<Message> {
    return manager.save(
      manager.create(Message, {
        conversationId,
        senderId: event.actorId,
        body: SYSTEM_EVENT_FALLBACK[event.type],
        kind: MessageKind.System,
        systemEvent: event,
      }),
    );
  }

  /**
   * Post-commit MESSAGE_CREATED fan-out for a system message inserted inside a
   * transaction. Best-effort: the pill is already committed, so a hydration or
   * socket-relay failure must not turn a successful group mutation into a 500.
   */
  private async broadcastSystemMessage(message: Message): Promise<void> {
    try {
      await this.core.buildPostResult(message, message.senderId, true);
    } catch {
      // best-effort: the pill persisted; a live relay failure is benign.
    }
  }

  /**
   * Emit a domain event WITHOUT letting a synchronous listener failure surface
   * to the caller — for post-commit socket fan-out, where the write already
   * committed and the frame is a live-refresh nicety, not part of the write.
   */
  private emitBestEffort(eventName: string, payload: unknown): void {
    try {
      this.eventEmitter.emit(eventName, payload);
    } catch {
      // best-effort: post-commit live fan-out never fails a committed write.
    }
  }

  /**
   * Group member-gate for a batch of candidate user ids: a block either way is a
   * hard stop, and each candidate must be an accepted connection of the actor.
   * Two queries total (batched block set + the accepted-connection subset among
   * exactly these candidates) regardless of candidate count, replacing the
   * previous per-candidate `isBlockedEitherWay` + `areConnected` pair (N+1).
   * Block is checked before connection per candidate, matching the previous
   * sequential precedence.
   *
   * The connection test is `acceptedConnectionsAmong(actor, candidates)` — a
   * query bounded by the (small) candidate set — NOT the 200-capped
   * `getAcceptedConnectionUserIds(actor)`: an actor with more than
   * `DEFAULT_LIST_LIMIT` accepted connections would otherwise have a valid
   * connection beyond the cap wrongly rejected here.
   */
  private async assertAddableMembers(
    actorUserId: string,
    candidateUserIds: string[],
  ): Promise<void> {
    if (!candidateUserIds.length) {
      return;
    }
    const [blockedUserIds, connectedUserIds] = await Promise.all([
      this.blockFilter.blockedUserIds(actorUserId, candidateUserIds),
      this.connectionsService.acceptedConnectionsAmong(
        actorUserId,
        candidateUserIds,
      ),
    ]);
    for (const candidateUserId of candidateUserIds) {
      if (blockedUserIds.has(candidateUserId)) {
        throw new ForbiddenException(
          'You cannot add a member you have blocked (or who has blocked you)',
        );
      }
      if (!connectedUserIds.has(candidateUserId)) {
        throw new ForbiddenException(
          'You can only add accepted connections to a group',
        );
      }
    }
  }

  /**
   * Builds the frontend-contract `ConversationResponse` for a GROUP thread —
   * `otherParticipant`/counterpart watermarks are null (a group has no single
   * counterpart), and it instead carries the title, group avatar, active
   * member roster, and this caller's left/muted state. Returned by
   * `createGroup` and reused after a group mutation.
   */
  private async toGroupConversationResponse(
    convo: Conversation,
    userId: string,
  ): Promise<ConversationResponse> {
    const [participantRows, lastByConvo, unreadByConvo] = await Promise.all([
      this.participants.find({ where: { conversationId: convo.id } }),
      this.core.lastMessagesByConversation([convo.id]),
      this.core.unreadCountsByConversation([convo.id], userId),
    ]);
    const callerRow = participantRows.find((row) => row.userId === userId);
    const profiles = await this.profiles.find({
      where: { userId: In(participantRows.map((row) => row.userId)) },
    });
    const profileByUser = new Map(profiles.map((p) => [p.userId, p]));
    const members = this.core.buildMemberSummaries(
      participantRows,
      profileByUser,
    );

    const lastMessage = lastByConvo.get(convo.id) ?? null;
    const clearedAt = callerRow?.clearedAt ?? null;
    const clearedLastMessage =
      clearedAt && lastMessage && lastMessage.createdAt <= clearedAt
        ? null
        : lastMessage;
    const reactionsByMessage = await this.core.reactionSummariesByMessage(
      clearedLastMessage ? [clearedLastMessage.id] : [],
      userId,
    );

    return {
      id: convo.id,
      type: 'group',
      otherParticipant: null,
      lastMessage: clearedLastMessage
        ? this.core.buildLastMessagePreview(
            clearedLastMessage,
            convo.id,
            profileByUser,
            reactionsByMessage.get(clearedLastMessage.id) ?? [],
          )
        : null,
      unreadCount: unreadByConvo.get(convo.id) ?? 0,
      updatedAt: (
        clearedLastMessage?.createdAt ?? convo.createdAt
      ).toISOString(),
      otherLastReadAt: null,
      otherDeliveredAt: null,
      otherParticipantId: null,
      kind: 'group',
      title: convo.title,
      avatarUrl: toImageUrl(convo.avatarUrl),
      memberCount: members.length,
      members,
      isOfficial: false,
      muted: callerRow?.muted ?? false,
      pinnedAt: callerRow?.pinnedAt?.toISOString() ?? null,
      favorite: callerRow?.favoritedAt != null,
      hasLeft: callerRow?.leftAt != null,
      ...this.core.groupCapabilities(
        callerRow?.role,
        callerRow?.leftAt != null,
      ),
    };
  }
}
