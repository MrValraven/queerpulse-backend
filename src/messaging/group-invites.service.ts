import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, Repository } from 'typeorm';
import { toImageUrl } from '../common/image-url';
import { cropFor } from '../media-crops/crop-response';
import { MediaCropService } from '../media-crops/media-crops.service';
import { BlockFilterService } from '../social/block-filter.service';
import { IdentitiesService } from '../identities/identities.service';
import { PreferencesService } from '../preferences/preferences.service';
import { Profile } from '../users/entities/profile.entity';
import {
  ConversationParticipant,
  ConversationRole,
} from './entities/conversation-participant.entity';
import { Conversation, ConversationKind } from './entities/conversation.entity';
import { GroupInvite, GroupInviteStatus } from './entities/group-invite.entity';
import { Message, MessageKind } from './entities/message.entity';
import { GROUP_ROLE_REQUIRED_CODE } from './message-annotations.service';
import {
  computeGroupLeftReason,
  ConversationResponse,
  GroupInviteSummary,
  GroupJoinPreview,
  MessageResponse,
  requireAuthorSummary,
} from './message-response';
import { MAX_GROUP_MEMBERS } from './messaging.constants';
import {
  CONVERSATION_CREATED,
  ConversationCreatedEvent,
  MESSAGE_CREATED,
  MessageCreatedEvent,
} from './messaging.events';
import { MessagingCoreService } from './messaging-core.service';

/**
 * Messaging scan section 8 (Groups) coded errors for the invite/link flows:
 * mirrors `GroupsService`'s own `GROUP_FULL_CODE`/`GROUP_DISSOLVED_CODE`/
 * `GROUP_ADD_REFUSED_CODE` string-for-string (same wire contract, kept as
 * separate literals here rather than an import: `GroupsService` itself
 * imports FROM this file for the seat-or-invite write path, so importing back
 * would be a circular module dependency).
 */
const GROUP_FULL_CODE = 'GROUP_FULL';
const GROUP_DISSOLVED_CODE = 'GROUP_DISSOLVED';
const GROUP_ADD_REFUSED_CODE = 'GROUP_ADD_REFUSED';
export const INVITE_NOT_FOUND_CODE = 'INVITE_NOT_FOUND';
export const INVITE_LINK_INVALID_CODE = 'INVITE_LINK_INVALID';
export const REMOVED_FROM_GROUP_CODE = 'REMOVED_FROM_GROUP';

/**
 * PRD-353/PRD-358: the invitee/owner-admin-initiated half of group invites
 * (accept/decline/revoke/list) plus the join-by-link flow. `GroupsService`
 * owns CREATING an invite (part of its own `addMembers`/`createGroup`
 * seat-or-invite transaction) and reading an owner/admin's own pending
 * invites for `ConversationResponse.pendingInvites`; this service owns
 * everything that happens to an invite (or a link) AFTER that, from the
 * invitee's or a joiner's side.
 *
 * Deliberately does NOT depend on `GroupsService`, and `GroupsService` does
 * not depend on this file either: the two touch the same `GroupInvite`/
 * `Conversation`/`ConversationParticipant` tables and the same
 * `MessagingCoreService` pill-broadcast contract, kept in sync BY HAND
 * (`seatParticipant`/`insertJoinPill`/`broadcastPill` below mirror
 * `GroupsService`'s own private methods of the same shape) rather than a
 * shared import, so neither service ever becomes the other's circular
 * dependency.
 */
@Injectable()
export class GroupInvitesService {
  constructor(
    @InjectRepository(GroupInvite)
    private readonly invites: Repository<GroupInvite>,
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    @InjectRepository(ConversationParticipant)
    private readonly participants: Repository<ConversationParticipant>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly core: MessagingCoreService,
    private readonly blockFilter: BlockFilterService,
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
    private readonly mediaCropService: MediaCropService,
    private readonly preferencesService: PreferencesService,
    // Task 8: resolves the joiner's own profile identity so
    // `insertJoinPill` can stamp `senderIdentityId`, satisfying
    // `CHK_messages_sender_identity`.
    private readonly identities: IdentitiesService,
  ) {}

  /**
   * `GET /group-invites`: every PENDING invite addressed to the caller,
   * newest first. Returns a bare array (the frontend contract), never a
   * wrapper object.
   */
  async listMyInvites(userId: string): Promise<GroupInviteSummary[]> {
    const rows = await this.invites.find({
      where: { inviteeId: userId, status: GroupInviteStatus.Pending },
      order: { createdAt: 'DESC' },
    });
    if (!rows.length) {
      return [];
    }
    const conversationIds = [...new Set(rows.map((row) => row.conversationId))];
    const [convos, inviterProfiles, activeCounts, myActiveConversationIds] =
      await Promise.all([
        this.conversations.find({ where: { id: In(conversationIds) } }),
        this.profiles.find({
          where: {
            userId: In(
              [...new Set(rows.map((row) => row.inviterId))].filter(
                (id): id is string => id != null,
              ),
            ),
          },
        }),
        this.activeMemberCountsByConversation(conversationIds),
        // A pending row normally gets marked `accepted` the moment the caller
        // is seated by any path (`accept`, `joinByToken`, or a re-add), but a
        // pending invite could in principle still outlive that (a row created
        // just after the seating write read its own snapshot). Belt-and-
        // braces: never show, on the Requests tab, an invite to a group the
        // caller is already an active member of.
        this.myActiveConversationIds(userId, conversationIds),
      ]);
    const convoById = new Map(convos.map((c) => [c.id, c]));
    const inviterProfileByUser = new Map(
      inviterProfiles.map((p) => [p.userId, p]),
    );
    return rows
      .filter(
        (row) =>
          convoById.has(row.conversationId) &&
          !myActiveConversationIds.has(row.conversationId),
      )
      .map((row) => {
        const convo = convoById.get(row.conversationId)!;
        return {
          id: row.id,
          conversationId: row.conversationId,
          title: convo.title,
          avatarUrl: toImageUrl(convo.avatarUrl),
          memberCount: activeCounts.get(row.conversationId) ?? 0,
          inviter: requireAuthorSummary(
            row.inviterId ? inviterProfileByUser.get(row.inviterId) : undefined,
          ),
          createdAt: row.createdAt.toISOString(),
        };
      });
  }

  /**
   * `POST /group-invites/:inviteId/accept`: the invitee accepts. Re-checks
   * everything at accept time rather than trusting the state the invite was
   * created under: still pending and addressed to this caller, the group has
   * not since been dissolved, the cap (a pending invite counts toward it only
   * NOW, not when it was sent), and the block gate against the group's
   * current active roster. Seats the caller (reactivating a voluntarily-left
   * row, same as `GroupsService.addMembers`'s reactivation branch), posts a
   * `member_joined` pill (`value: 'invite'`), and marks the invite accepted.
   */
  async accept(
    inviteId: string,
    userId: string,
  ): Promise<ConversationResponse> {
    const invite = await this.invites.findOne({ where: { id: inviteId } });
    if (
      !invite ||
      invite.inviteeId !== userId ||
      invite.status !== GroupInviteStatus.Pending
    ) {
      throw new NotFoundException({
        statusCode: 404,
        message: 'That invite no longer exists',
        code: INVITE_NOT_FOUND_CODE,
      });
    }
    const convo = await this.conversations.findOne({
      where: { id: invite.conversationId },
    });
    if (!convo || convo.kind !== ConversationKind.Group) {
      throw new NotFoundException({
        statusCode: 404,
        message: 'That invite no longer exists',
        code: INVITE_NOT_FOUND_CODE,
      });
    }
    if (convo.dissolvedAt) {
      throw new ForbiddenException({
        statusCode: 403,
        message: 'This group has ended',
        code: GROUP_DISSOLVED_CODE,
      });
    }
    const activeMemberUserIds = await this.activeMemberUserIds(convo.id);
    if (activeMemberUserIds.length + 1 > MAX_GROUP_MEMBERS) {
      throw new ConflictException({
        statusCode: 409,
        message: `A group can have at most ${MAX_GROUP_MEMBERS} members`,
        code: GROUP_FULL_CODE,
      });
    }
    const blocked = await this.blockFilter.blockedAgainstAnyOf(
      [userId],
      activeMemberUserIds,
    );
    if (blocked.has(userId)) {
      throw new ForbiddenException({
        statusCode: 403,
        message: 'That member cannot be added to this group right now',
        code: GROUP_ADD_REFUSED_CODE,
      });
    }
    const existingRow = await this.participants.findOne({
      where: { conversationId: convo.id, userId },
      select: { id: true, clearedAt: true, leftAt: true },
    });
    // A second `addMembers` call could have seated this exact invitee
    // directly (their policy read `connections` at that later moment, or a
    // prior-row check no longer applied) WHILE this invite sat pending and
    // unanswered. Accepting must never re-run `seatParticipant` over an
    // already-active row: doing so would blindly reset `role` back to
    // `member`, silently demoting an admin the second addMembers call (or a
    // promotion since) had already granted. Answer the invite (it WAS
    // accepted) without touching the participant row or posting a second
    // join pill; the caller is already seated with whatever role they
    // actually hold.
    if (existingRow && existingRow.leftAt == null) {
      const updateResult = await this.invites.update(
        { id: invite.id, status: GroupInviteStatus.Pending },
        { status: GroupInviteStatus.Accepted, respondedAt: new Date() },
      );
      if (!updateResult.affected) {
        // Lost a race (declined/revoked between the read above and here),
        // read consistently with the transactional branch below rather than
        // silently answering a caller whose invite no longer exists.
        throw new NotFoundException({
          statusCode: 404,
          message: 'That invite no longer exists',
          code: INVITE_NOT_FOUND_CODE,
        });
      }
      return this.buildGroupConversationResponse(convo, userId);
    }
    const systemMessage = await this.dataSource.transaction(async (manager) => {
      // ENG-239: the unlocked pre-transaction count above is only a fast
      // fail, so re-run it under a row lock on the conversation, immediately
      // before seating, so two callers racing at the ceiling (e.g. this
      // accept and a concurrent `joinByToken`/`addMembers`) can never both
      // commit and leave the group over `MAX_GROUP_MEMBERS`; the loser's
      // `GROUP_FULL` throw here rolls its own transaction back.
      await manager.findOne(Conversation, {
        where: { id: convo.id },
        lock: { mode: 'pessimistic_write' },
      });
      const activeCountNow = await manager.count(ConversationParticipant, {
        where: { conversationId: convo.id, leftAt: IsNull() },
      });
      if (activeCountNow + 1 > MAX_GROUP_MEMBERS) {
        throw new ConflictException({
          statusCode: 409,
          message: `A group can have at most ${MAX_GROUP_MEMBERS} members`,
          code: GROUP_FULL_CODE,
        });
      }
      const joinerIdentityId =
        await this.identities.resolveProfileIdentityId(userId);
      await this.seatParticipant(
        manager,
        convo.id,
        userId,
        joinerIdentityId,
        existingRow ?? null,
      );
      const updateResult = await manager.update(
        GroupInvite,
        { id: invite.id, status: GroupInviteStatus.Pending },
        { status: GroupInviteStatus.Accepted, respondedAt: new Date() },
      );
      if (!updateResult.affected) {
        // Lost a race (declined/revoked between the read above and here).
        throw new NotFoundException({
          statusCode: 404,
          message: 'That invite no longer exists',
          code: INVITE_NOT_FOUND_CODE,
        });
      }
      return this.insertJoinPill(
        manager,
        convo.id,
        userId,
        joinerIdentityId,
        'invite',
      );
    });
    await this.broadcastPill(systemMessage);
    this.emitBestEffort(CONVERSATION_CREATED, {
      conversationId: convo.id,
      memberUserIds: [userId],
    } satisfies ConversationCreatedEvent);
    return this.buildGroupConversationResponse(convo, userId);
  }

  /**
   * `POST /group-invites/:inviteId/decline`: the invitee declines. A past
   * accepted/declined/revoked row is never re-answered (re-checked here, not
   * just at read time), and the partial unique index still lets a FRESH
   * pending invite follow a decline later.
   */
  async decline(inviteId: string, userId: string): Promise<void> {
    const invite = await this.invites.findOne({ where: { id: inviteId } });
    if (
      !invite ||
      invite.inviteeId !== userId ||
      invite.status !== GroupInviteStatus.Pending
    ) {
      throw new NotFoundException({
        statusCode: 404,
        message: 'That invite no longer exists',
        code: INVITE_NOT_FOUND_CODE,
      });
    }
    await this.invites.update(
      { id: inviteId, status: GroupInviteStatus.Pending },
      { status: GroupInviteStatus.Declined, respondedAt: new Date() },
    );
  }

  /**
   * `DELETE /conversations/:id/invites/:inviteId`: owner/admin of THAT group
   * revokes a pending invite before it is answered.
   */
  async revoke(
    conversationId: string,
    inviteId: string,
    actorUserId: string,
  ): Promise<void> {
    const [actor, convo] = await Promise.all([
      this.participants.findOne({
        where: { conversationId, userId: actorUserId },
        select: { role: true, leftAt: true },
      }),
      this.conversations.findOne({
        where: { id: conversationId },
        select: { dissolvedAt: true },
      }),
    ]);
    if (
      !actor ||
      actor.leftAt ||
      (actor.role !== ConversationRole.Owner &&
        actor.role !== ConversationRole.Admin)
    ) {
      // Coded like every other refusal in this file, and mirroring
      // `MessageAnnotationsService`'s identical owner/admin gate for pins.
      throw new ForbiddenException({
        statusCode: 403,
        message: 'Only a group owner or admin may do that',
        code: GROUP_ROLE_REQUIRED_CODE,
      });
    }
    if (convo?.dissolvedAt) {
      throw new ForbiddenException({
        statusCode: 403,
        message: 'This group has ended',
        code: GROUP_DISSOLVED_CODE,
      });
    }
    const invite = await this.invites.findOne({
      where: { id: inviteId, conversationId },
    });
    if (!invite || invite.status !== GroupInviteStatus.Pending) {
      throw new NotFoundException({
        statusCode: 404,
        message: 'That invite no longer exists',
        code: INVITE_NOT_FOUND_CODE,
      });
    }
    await this.invites.update(
      { id: inviteId, status: GroupInviteStatus.Pending },
      { status: GroupInviteStatus.Revoked, respondedAt: new Date() },
    );
  }

  /**
   * `GET /conversations/join/:token`: an unauthenticated-membership preview
   * before the caller decides whether to `POST` the same path. 404s
   * `INVITE_LINK_INVALID` for an unknown token, a dissolved group, a caller
   * this group's `removeMember` removed, OR a caller blocked either way with
   * an active member alike; never distinguishes any of these, so a stale or
   * refused link reveals nothing about whether the group ever existed, let
   * alone its title/description/member count, the same gate `joinByToken`
   * itself enforces, just answered with the token's own indistinguishable
   * 404 rather than `REMOVED_FROM_GROUP`/`GROUP_ADD_REFUSED`.
   */
  async previewByToken(
    token: string,
    userId: string,
  ): Promise<GroupJoinPreview> {
    const convo = await this.conversations.findOne({
      where: { inviteToken: token, kind: ConversationKind.Group },
    });
    if (!convo || convo.dissolvedAt) {
      throw new NotFoundException({
        statusCode: 404,
        message: 'That invite link is no longer valid',
        code: INVITE_LINK_INVALID_CODE,
      });
    }
    const [activeMemberUserIds, callerRow] = await Promise.all([
      this.activeMemberUserIds(convo.id),
      this.participants.findOne({
        where: { conversationId: convo.id, userId },
        select: { leftAt: true, removedAt: true },
      }),
    ]);
    if (callerRow?.removedAt) {
      throw new NotFoundException({
        statusCode: 404,
        message: 'That invite link is no longer valid',
        code: INVITE_LINK_INVALID_CODE,
      });
    }
    const blocked = await this.blockFilter.blockedAgainstAnyOf(
      [userId],
      activeMemberUserIds,
    );
    if (blocked.has(userId)) {
      throw new NotFoundException({
        statusCode: 404,
        message: 'That invite link is no longer valid',
        code: INVITE_LINK_INVALID_CODE,
      });
    }
    return {
      conversationId: convo.id,
      title: convo.title,
      avatarUrl: toImageUrl(convo.avatarUrl),
      description: convo.description,
      memberCount: activeMemberUserIds.length,
      isMember: callerRow != null && callerRow.leftAt == null,
    };
  }

  /**
   * `POST /conversations/join/:token`: the caller joins voluntarily, so
   * their own `group_add_policy` is never consulted (this is not an add).
   * Idempotent for an already-active member; refuses `REMOVED_FROM_GROUP` for
   * a row an owner/admin removed (a voluntary leave, by contrast, IS
   * reactivable by a link: the member chose to go and the same member is
   * choosing to come back). Block gate + cap apply exactly like `accept`.
   */
  async joinByToken(
    token: string,
    userId: string,
  ): Promise<ConversationResponse> {
    const convo = await this.conversations.findOne({
      where: { inviteToken: token, kind: ConversationKind.Group },
    });
    if (!convo || convo.dissolvedAt) {
      throw new NotFoundException({
        statusCode: 404,
        message: 'That invite link is no longer valid',
        code: INVITE_LINK_INVALID_CODE,
      });
    }
    const existingRow = await this.participants.findOne({
      where: { conversationId: convo.id, userId },
    });
    if (existingRow && existingRow.leftAt == null) {
      // PRD-353: a pending invite for a group the caller is now (already)
      // active in must not keep showing on their Requests tab, resolve
      // silently on Accept, or block a genuine future re-invite via the
      // pending unique index; see the transactional branch below for the
      // same write.
      await this.invites.update(
        {
          conversationId: convo.id,
          inviteeId: userId,
          status: GroupInviteStatus.Pending,
        },
        { status: GroupInviteStatus.Accepted, respondedAt: new Date() },
      );
      return this.buildGroupConversationResponse(convo, userId);
    }
    // Reads `removedAt`, NOT `removedBy`: `removedBy` carries an `ON DELETE
    // SET NULL` foreign key to the remover's own account, so it goes quietly
    // NULL once that account is deleted, and this gate would otherwise let a
    // removed member back in via a stale link the moment the remover left
    // the platform. `removedAt` carries no such FK.
    if (existingRow?.removedAt) {
      throw new ForbiddenException({
        statusCode: 403,
        message: 'You were removed from this group',
        code: REMOVED_FROM_GROUP_CODE,
      });
    }
    const activeMemberUserIds = await this.activeMemberUserIds(convo.id);
    if (activeMemberUserIds.length + 1 > MAX_GROUP_MEMBERS) {
      throw new ConflictException({
        statusCode: 409,
        message: `A group can have at most ${MAX_GROUP_MEMBERS} members`,
        code: GROUP_FULL_CODE,
      });
    }
    const blocked = await this.blockFilter.blockedAgainstAnyOf(
      [userId],
      activeMemberUserIds,
    );
    if (blocked.has(userId)) {
      throw new ForbiddenException({
        statusCode: 403,
        message: 'That member cannot be added to this group right now',
        code: GROUP_ADD_REFUSED_CODE,
      });
    }
    const systemMessage = await this.dataSource.transaction(async (manager) => {
      // ENG-239: the unlocked pre-transaction count above is only a fast
      // fail, so re-run it under a row lock on the conversation, immediately
      // before seating, so two callers racing at the ceiling (e.g. this join
      // and a concurrent `accept`/`addMembers`) can never both commit and
      // leave the group over `MAX_GROUP_MEMBERS`; the loser's `GROUP_FULL`
      // throw here rolls its own transaction back.
      await manager.findOne(Conversation, {
        where: { id: convo.id },
        lock: { mode: 'pessimistic_write' },
      });
      const activeCountNow = await manager.count(ConversationParticipant, {
        where: { conversationId: convo.id, leftAt: IsNull() },
      });
      if (activeCountNow + 1 > MAX_GROUP_MEMBERS) {
        throw new ConflictException({
          statusCode: 409,
          message: `A group can have at most ${MAX_GROUP_MEMBERS} members`,
          code: GROUP_FULL_CODE,
        });
      }
      const joinerIdentityId =
        await this.identities.resolveProfileIdentityId(userId);
      await this.seatParticipant(
        manager,
        convo.id,
        userId,
        joinerIdentityId,
        existingRow ?? null,
      );
      // PRD-353: a pending invite for this exact (conversation, invitee)
      // pair, if one happens to exist alongside the link, is answered by
      // this join too; see the idempotent branch above for the same write.
      await manager.update(
        GroupInvite,
        {
          conversationId: convo.id,
          inviteeId: userId,
          status: GroupInviteStatus.Pending,
        },
        { status: GroupInviteStatus.Accepted, respondedAt: new Date() },
      );
      return this.insertJoinPill(
        manager,
        convo.id,
        userId,
        joinerIdentityId,
        'link',
      );
    });
    await this.broadcastPill(systemMessage);
    this.emitBestEffort(CONVERSATION_CREATED, {
      conversationId: convo.id,
      memberUserIds: [userId],
    } satisfies ConversationCreatedEvent);
    return this.buildGroupConversationResponse(convo, userId);
  }

  /**
   * Reactivate-or-insert one participant row: the SAME contract
   * `GroupsService.addMembers`'s reactivation branch uses: `clearedAt`
   * advances to the later of its old value and the row's own `leftAt` (so
   * history resumes from the RE-JOIN point, not from the beginning of the
   * thread, and not by resurrecting anything the member had cleared for
   * themselves before leaving), `leftAt` clears, role resets to `member`, and
   * `removedBy` clears (a re-seated member reads as freshly added, not still
   * "removed").
   *
   * A brand-new row carries `joinerIdentityId`, the joiner's own profile
   * identity (`conversation_participants.identity_id` is NOT NULL). A
   * reactivated row keeps the identity it already holds.
   */
  private async seatParticipant(
    manager: EntityManager,
    conversationId: string,
    userId: string,
    joinerIdentityId: string,
    existing: Pick<
      ConversationParticipant,
      'id' | 'clearedAt' | 'leftAt'
    > | null,
  ): Promise<void> {
    if (existing) {
      const resumeFloor = [existing.clearedAt, existing.leftAt]
        .filter((value): value is Date => value != null)
        .reduce<Date | null>(
          (latest, value) =>
            latest === null || value > latest ? value : latest,
          null,
        );
      await manager.update(
        ConversationParticipant,
        { id: existing.id },
        {
          clearedAt: resumeFloor,
          leftAt: null,
          role: ConversationRole.Member,
          // Both columns, together: `removedAt` is the durable record
          // `computeGroupLeftReason`/`joinByToken`'s own REMOVED_FROM_GROUP
          // gate actually read.
          removedBy: null,
          removedAt: null,
        },
      );
    } else {
      await manager.save(
        manager.create(ConversationParticipant, {
          conversationId,
          userId,
          identityId: joinerIdentityId,
          role: ConversationRole.Member,
        }),
      );
    }
  }

  /** Inserts the `member_joined` pill (actor = the joiner) inside the
   *  caller's transaction. `body` mirrors `GroupsService`'s own
   *  `SYSTEM_EVENT_FALLBACK['member_joined']` fallback text exactly.
   *
   *  Task 8: `CHK_messages_sender_identity` requires `senderIdentityId`
   *  whenever `senderId` is set. The joiner authors this pill as themselves,
   *  so it stamps their own profile identity, resolved once by the caller
   *  for both the seat and this pill. */
  private insertJoinPill(
    manager: EntityManager,
    conversationId: string,
    actorId: string,
    senderIdentityId: string,
    value: 'invite' | 'link',
  ): Promise<Message> {
    return manager.save(
      manager.create(Message, {
        conversationId,
        senderId: actorId,
        senderIdentityId,
        body: 'joined',
        kind: MessageKind.System,
        systemEvent: { type: 'member_joined', actorId, value },
      }),
    );
  }

  /**
   * Post-commit MESSAGE_CREATED fan-out for a `member_joined` pill: mirrors
   * `GroupsService.broadcastPill` exactly (same `buildPostResult` call, same
   * `actorIsMe`/`targetIsMe` stripping, same archived-at clear), best-effort:
   * the pill already persisted, so a relay failure here must not surface.
   */
  private async broadcastPill(message: Message): Promise<void> {
    try {
      const actorId = message.systemEvent?.actorId ?? message.senderId;
      if (!actorId) {
        return;
      }
      const { view, response } = await this.core.buildPostResult(
        message,
        actorId,
        false,
      );
      const broadcastResponse: MessageResponse = response.systemEvent
        ? {
            ...response,
            systemEvent: {
              ...response.systemEvent,
              actorIsMe: undefined,
              targetIsMe: undefined,
            },
          }
        : response;
      await this.participants
        .createQueryBuilder()
        .update(ConversationParticipant)
        .set({ archivedAt: null })
        .where('conversation_id = :conversationId', {
          conversationId: message.conversationId,
        })
        .andWhere('archived_at IS NOT NULL')
        .execute();
      this.eventEmitter.emit(MESSAGE_CREATED, {
        conversationId: message.conversationId,
        message: view,
        response: broadcastResponse,
      } satisfies MessageCreatedEvent);
    } catch {
      // best-effort: the pill persisted; a live relay failure is benign.
    }
  }

  private emitBestEffort(eventName: string, payload: unknown): void {
    try {
      this.eventEmitter.emit(eventName, payload);
    } catch {
      // best-effort: post-commit live fan-out never fails a committed write.
    }
  }

  private async activeMemberUserIds(conversationId: string): Promise<string[]> {
    const rows = await this.participants.find({
      where: { conversationId, leftAt: IsNull() },
      select: { userId: true },
    });
    return rows.map((row) => row.userId);
  }

  private async activeMemberCountsByConversation(
    conversationIds: string[],
  ): Promise<Map<string, number>> {
    if (!conversationIds.length) {
      return new Map();
    }
    const rows = await this.participants
      .createQueryBuilder('p')
      .select('p.conversation_id', 'conversationId')
      .addSelect('COUNT(*)', 'count')
      .where('p.conversation_id IN (:...conversationIds)', { conversationIds })
      .andWhere('p.left_at IS NULL')
      .groupBy('p.conversation_id')
      .getRawMany<{ conversationId: string; count: string }>();
    return new Map(rows.map((row) => [row.conversationId, Number(row.count)]));
  }

  /** The subset of `conversationIds` where `userId` already holds an ACTIVE
   *  participant row, for `listMyInvites`' belt-and-braces filter above. */
  private async myActiveConversationIds(
    userId: string,
    conversationIds: string[],
  ): Promise<Set<string>> {
    if (!conversationIds.length) {
      return new Set();
    }
    const rows = await this.participants.find({
      where: { conversationId: In(conversationIds), userId, leftAt: IsNull() },
      select: { conversationId: true },
    });
    return new Set(rows.map((row) => row.conversationId));
  }

  /**
   * Builds the frontend-contract `ConversationResponse` for the caller's own
   * view of the group they just accepted/joined into (or, for
   * `joinByToken`'s idempotent early return, one they were already active
   * in). Mirrors `GroupsService.toGroupConversationResponse` field-for-field
   * (see this file's own header doc for why the two are hand-kept-in-sync
   * mirrors rather than one shared method, avoiding a circular service
   * dependency), WITH ONE DELIBERATE GAP: `pendingInvites` is always `[]`
   * here, never populated even for an existing owner/admin who re-visits
   * their own join link (the idempotent path in `joinByToken`): a narrow
   * edge case this service accepts rather than duplicating `GroupsService`'s
   * own `pendingInvites` query for a caller who is never freshly seated as
   * owner/admin in the first place (`seatParticipant` always seats as
   * `member`), so the client's group-info panel (`GET /conversations`)
   * remains the authority for that list regardless.
   */
  private async buildGroupConversationResponse(
    convo: Conversation,
    userId: string,
  ): Promise<ConversationResponse> {
    const [participantRows, lastByConvo, unreadByConvo] = await Promise.all([
      this.participants.find({ where: { conversationId: convo.id } }),
      this.core.lastMessagesByConversation([convo.id], userId),
      this.core.unreadCountsByConversation([convo.id], userId),
    ]);
    const callerRow = participantRows.find((row) => row.userId === userId);
    const profiles = await this.profiles.find({
      where: { userId: In(participantRows.map((row) => row.userId)) },
    });
    const profileByUser = new Map(profiles.map((p) => [p.userId, p]));
    const privacyByUser =
      await this.preferencesService.getMessagingPrivacyForUsers(
        participantRows.map((row) => row.userId),
      );
    const hasCallerLeft = callerRow?.leftAt != null;
    const activeMemberCount = participantRows.filter(
      (row) => row.leftAt == null,
    ).length;
    const members = hasCallerLeft
      ? []
      : this.core.buildMemberSummaries(
          participantRows,
          profileByUser,
          userId,
          privacyByUser,
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
    const avatarCrops = await this.mediaCropService.getMany(
      convo.avatarUrl ? [convo.avatarUrl] : [],
    );
    const mentionByConvo = await this.core.hasUnreadMentionByConversation(
      [convo.id],
      userId,
      profileByUser.get(userId)?.slug,
    );
    const isOwnerOrAdmin =
      callerRow?.role === ConversationRole.Owner ||
      callerRow?.role === ConversationRole.Admin;
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
            userId,
          )
        : null,
      unreadCount: unreadByConvo.get(convo.id) ?? 0,
      updatedAt: (
        clearedLastMessage?.createdAt ?? convo.createdAt
      ).toISOString(),
      otherLastReadAt: null,
      // PRD-351: mirrors `otherLastReadAt` above exactly. A group has no
      // single DM counterpart, so the list path's own group row sends null
      // unconditionally (see `ConversationsService.listConversations`, where
      // `first` is undefined for a group and `canSeeOtherReadState` is
      // therefore always false); this builder matches that same convention.
      otherLastReadInstant: null,
      myLastReadAt: callerRow?.lastReadAt?.toISOString() ?? null,
      otherDeliveredAt: null,
      otherParticipantId: null,
      replyRequiresConnection: false,
      connectedSince: null,
      kind: 'group',
      title: convo.title,
      avatarUrl: toImageUrl(convo.avatarUrl),
      avatarCrop: cropFor(convo.avatarUrl, avatarCrops),
      memberCount: activeMemberCount,
      members,
      // ENG-253: populated on EVERY response (unlike `members`, which this
      // builder empties out once the caller has left), see
      // `ConversationMemberPreview`'s own doc. Reuses `buildMemberPreview`,
      // the same active-members-only, `MAX_MEMBER_PREVIEW`-capped helper the
      // list path calls, instead of a parallel capped-slice.
      memberPreview: this.core.buildMemberPreview(
        participantRows,
        profileByUser,
      ),
      isOfficial: false,
      muted: callerRow?.muted ?? false,
      mutedUntil: callerRow?.mutedUntil?.toISOString() ?? null,
      hasUnreadMention: mentionByConvo.get(convo.id) ?? false,
      pinnedAt: callerRow?.pinnedAt?.toISOString() ?? null,
      favorite: callerRow?.favoritedAt != null,
      markedUnreadAt: callerRow?.markedUnreadAt?.toISOString() ?? null,
      hasLeft: callerRow?.leftAt != null,
      description: convo.description,
      dissolvedAt: convo.dissolvedAt?.toISOString() ?? null,
      leftReason: computeGroupLeftReason({
        leftAt: callerRow?.leftAt,
        removedAt: callerRow?.removedAt,
        dissolvedAt: convo.dissolvedAt,
      }),
      inviteToken:
        !callerRow?.leftAt && !convo.dissolvedAt && isOwnerOrAdmin
          ? convo.inviteToken
          : null,
      canManageInviteLink:
        !hasCallerLeft && !convo.dissolvedAt && isOwnerOrAdmin,
      canTransferOwnership:
        !hasCallerLeft &&
        !convo.dissolvedAt &&
        callerRow?.role === ConversationRole.Owner,
      canDissolve:
        !hasCallerLeft &&
        !convo.dissolvedAt &&
        callerRow?.role === ConversationRole.Owner,
      // A caller who just joined/accepted is a plain `member`, never
      // owner/admin, so they never see anyone else's pending invites here.
      pendingInvites: [],
      ...this.core.groupCapabilities(callerRow?.role, hasCallerLeft),
    };
  }
}
