import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, Repository } from 'typeorm';
import { toImageUrl } from '../common/image-url';
import { toStoredPlainTextOrNull } from '../communities/community-plain-text';
import { assertNoForeignUploadIntroduced } from '../storage/assert-no-foreign-upload';
import { cropFor } from '../media-crops/crop-response';
import { MediaCropService } from '../media-crops/media-crops.service';
import { BlockFilterService } from '../social/block-filter.service';
import { ConnectionsService } from '../connections/connections.service';
import { Identity, IdentityKind } from '../identities/entities/identity.entity';
import { IdentitiesService } from '../identities/identities.service';
import { PreferencesService } from '../preferences/preferences.service';
import { GroupAddPolicy } from '../preferences/entities/member-preferences.entity';
import { Profile } from '../users/entities/profile.entity';
import {
  ConversationParticipant,
  ConversationRole,
} from './entities/conversation-participant.entity';
import { Conversation, ConversationKind } from './entities/conversation.entity';
import { GroupInvite, GroupInviteStatus } from './entities/group-invite.entity';
import { Message, MessageKind, SystemEvent } from './entities/message.entity';
import {
  computeGroupLeftReason,
  ConversationResponse,
  MessageResponse,
  requireAuthorSummary,
} from './message-response';
import { MAX_GROUP_MEMBERS } from './messaging.constants';
import {
  CONVERSATION_CREATED,
  CONVERSATION_MEMBERSHIP_REVOKED,
  ConversationCreatedEvent,
  ConversationMembershipRevokedEvent,
  GROUP_INVITE_CREATED,
  GROUP_MEMBERS_ADDED,
  GroupInviteCreatedEvent,
  GroupMembersAddedEvent,
  MESSAGE_CREATED,
  MessageCreatedEvent,
} from './messaging.events';
import { MessagingCoreService } from './messaging-core.service';

/** Messaging scan section 8 (Groups) coded errors, mirroring
 *  `PIN_LIMIT_REACHED_CODE`'s convention (`message-annotations.service.ts`)
 *  so the frontend can key a specific toast off each without matching prose. */
/** ENG-239: `createGroup`/`addMembers` would push active membership past
 *  `MAX_GROUP_MEMBERS`. */
export const GROUP_FULL_CODE = 'GROUP_FULL';
/** PRD-357: a write reached a group whose owner (or last leaver) already
 *  ended it: every group write past `requireGroupRole` refuses this way. */
export const GROUP_DISSOLVED_CODE = 'GROUP_DISSOLVED';
/** PRD-354: a candidate is blocked either way with the adder OR with any
 *  active member, refused with copy that never names who. */
export const GROUP_ADD_REFUSED_CODE = 'GROUP_ADD_REFUSED';

/**
 * Plain-text `body` for each kind of system message. This is only a FALLBACK for
 * consumers that don't render the structured `systemEvent` (push previews,
 * search, the inbox preview in a non-group-aware client): the actual timeline
 * pill is built by the CLIENT from `systemEvent`, bilingually. English by design
 * (server-stored content, like member/message text); see the i18n note in
 * `catalogs/en/messages.ts`.
 */
const SYSTEM_EVENT_FALLBACK: Record<SystemEvent['type'], string> = {
  group_created: 'created the group',
  member_added: 'added a member',
  member_removed: 'removed a member',
  member_left: 'left the group',
  group_renamed: 'renamed the group',
  member_promoted: 'made a member an admin',
  member_demoted: 'removed a member as admin',
  owner_changed: 'is now the owner',
  group_photo_changed: 'changed the group photo',
  group_description_changed: 'changed the group description',
  member_joined: 'joined',
  group_dissolved: 'ended this group',
  moved_to_business_mailbox: 'This conversation moved to the business mailbox',
};

/**
 * Group role precedence (lower = more powerful). Used by the server-side role
 * gate (`requireGroupRole`) and owner-succession so a single comparison covers
 * "owner > admin > member". NEVER derived from the client: the caller's role is
 * always re-read from their participant row.
 */
const ROLE_RANK: Record<ConversationRole, number> = {
  [ConversationRole.Owner]: 0,
  [ConversationRole.Admin]: 1,
  [ConversationRole.Member]: 2,
};

/**
 * Groups concern of the split `MessagingService`: group thread creation,
 * membership (add/remove/leave), roles, and title/avatar edits: every
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
    // Batched crop lookup (`MediaCropService.getMany`) for a group's
    // `avatarUrl` sibling `avatarCrop`.
    private readonly mediaCropService: MediaCropService,
    // PRD-364: reciprocal read-receipt sharing for `buildMemberSummaries` in
    // `toGroupConversationResponse`; see `ConversationsService`'s identical
    // dependency for the full contract.
    private readonly preferencesService: PreferencesService,
    // PRD-353: read-only lookup of an owner/admin's own pending invites for
    // `toGroupConversationResponse`'s `pendingInvites`. Every WRITE to
    // `group_invites` in this service goes through the transaction's own
    // `manager` instead (see `addMembers`/`createGroup`/`leaveGroup`/
    // `dissolveGroup`), so this repository is read-only in practice.
    @InjectRepository(GroupInvite)
    private readonly groupInvites: Repository<GroupInvite>,
    // Task 8: resolves the creator's own profile identity for
    // `createGroup`'s reply-only guard and stamps every system pill's
    // `senderIdentityId` in `insertSystemMessage`, satisfying
    // `CHK_messages_sender_identity`.
    private readonly identities: IdentitiesService,
  ) {}

  /**
   * `POST /conversations/group`: create a group thread. The caller becomes its
   * `owner` participant; each resolved member joins as `member`. Members are
   * addressed by their profile HANDLE (slug, the same identifier the DM start
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
    // Reply-only (Task 8): a group is opened by the member creating it,
    // acting as their own profile identity. Resolved once here and reused
    // for the opening pill below, passed straight into `insertSystemMessage`
    // via `resolvedActorIdentityId`.
    const initiatorIdentityId =
      await this.identities.resolveProfileIdentityId(userId);
    await this.core.assertInitiatorIsProfile(initiatorIdentityId);
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
    // PRD-353: seat-or-invite split. A brand-new group has no prior
    // participant rows to check (nobody could have left/been removed from a
    // conversation that does not exist yet), so this is purely the
    // candidate's own standing preference: `invite_only` becomes an invite,
    // `connections` (the default) is seated exactly as before. Batched: one
    // query for every candidate, never one per handle.
    const policyByUser =
      await this.preferencesService.getGroupAddPolicyForUsers(memberUserIds);
    const seatUserIds = memberUserIds.filter(
      (id) => policyByUser.get(id) !== GroupAddPolicy.InviteOnly,
    );
    const inviteUserIds = memberUserIds.filter(
      (id) => policyByUser.get(id) === GroupAddPolicy.InviteOnly,
    );
    // ENG-239: the owner seat plus every candidate actually SEATED must not
    // exceed the active-membership ceiling. A pending invite counts toward
    // the cap only at accept time, not here. Checked BEFORE the block/
    // connection gate so a doomed over-cap request never pays for it.
    if (1 + seatUserIds.length > MAX_GROUP_MEMBERS) {
      throw new ConflictException({
        statusCode: 409,
        message: `A group can have at most ${MAX_GROUP_MEMBERS} members`,
        code: GROUP_FULL_CODE,
      });
    }
    // Batched block + connection gate across ALL prospective members (seated
    // AND invited alike, only accepted connections of the creator may ever
    // be added or invited): two queries total instead of a sequential pair
    // per handle (N+1). No other active member exists yet, so the adder is
    // the only PRD-354 guardian.
    await this.assertAddableMembers(userId, memberUserIds, [userId]);

    // Single transaction: the conversation, every seated participant, every
    // invite row, AND the opening system message commit together: a throw
    // anywhere rolls the whole group back rather than leaving a group with no
    // `group_created` pill or a half-seated roster.
    const { conversation, systemMessage, createdInvites } =
      await this.dataSource.transaction(async (manager) => {
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
        // Every seat carries its member's own profile identity: the column is
        // NOT NULL, and a group member always speaks as themselves.
        const memberIdentityIdByUserId = await this.profileIdentityIdsByUser(
          manager,
          seatUserIds,
        );
        await manager.save([
          manager.create(ConversationParticipant, {
            conversationId: convo.id,
            userId,
            identityId: initiatorIdentityId,
            role: ConversationRole.Owner,
          }),
          ...seatUserIds.map((memberId) =>
            manager.create(ConversationParticipant, {
              conversationId: convo.id,
              userId: memberId,
              identityId: memberIdentityIdByUserId.get(memberId),
              role: ConversationRole.Member,
            }),
          ),
        ]);
        // PRD-353: a fresh conversation can hold no prior pending invite, so
        // no idempotency check is needed here (unlike `addMembers`): every
        // `invite_only` candidate gets a brand-new row.
        const createdInvites = await manager.save(
          inviteUserIds.map((inviteeUserId) =>
            manager.create(GroupInvite, {
              conversationId: convo.id,
              inviteeId: inviteeUserId,
              inviterId: userId,
            }),
          ),
        );
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
          initiatorIdentityId,
        );
        return { conversation: convo, systemMessage, createdInvites };
      });

    // Best-effort live fan-out AFTER commit — a socket relay failure must not
    // 500 a group that already committed. Broadcast the opening pill, then fan
    // the new group to each SEATED member's `user:<id>` room (they weren't in
    // the conversation room at creation, so a room-scoped `message:new` won't
    // reach them) so their inbox refetches live. An invited-only candidate is
    // not yet a participant, so they get no room fan-out and no
    // `group_created` pill, only the `GROUP_INVITE_CREATED` notification below.
    await this.broadcastSystemMessage(systemMessage);
    this.emitBestEffort(CONVERSATION_CREATED, {
      conversationId: conversation.id,
      memberUserIds: [userId, ...seatUserIds],
    } satisfies ConversationCreatedEvent);
    // PRD-334. The bell row + push telling each SEATED member they were added.
    // `seatUserIds` already excludes the creator and every invited candidate.
    this.emitBestEffort(GROUP_MEMBERS_ADDED, {
      conversationId: conversation.id,
      actorUserId: userId,
      addedUserIds: seatUserIds,
    } satisfies GroupMembersAddedEvent);
    // PRD-353. One bell row + push per invite, mirroring `GROUP_MEMBERS_ADDED`
    // above but for the candidates who could not be seated directly.
    for (const invite of createdInvites) {
      this.emitBestEffort(GROUP_INVITE_CREATED, {
        conversationId: conversation.id,
        inviteId: invite.id,
        inviteeUserId: invite.inviteeId,
        inviterUserId: userId,
      } satisfies GroupInviteCreatedEvent);
    }

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
    const { systemMessage, ownerChangedPill, promotedSuccessor } =
      await this.dataSource.transaction(async (manager) => {
        await manager.update(
          ConversationParticipant,
          { id: participant.id },
          { leftAt: new Date() },
        );
        // Owner succession: an owner who leaves hands ownership to the
        // longest-standing remaining member. Participant rows carry no join
        // timestamp, so "longest-standing" is approximated deterministically —
        // an existing admin before a plain member, ties broken by participant id
        // (a stable rule, documented in group-chat.md).
        //
        // Run BEFORE the `member_left` pill below (not after, as this used
        // to): a promoted successor's `owner_changed` pill is posted first,
        // so the timeline reads "X is now the owner" ahead of "X left".
        // PRD-355's auto-succession narrates itself exactly like a manual
        // `transferOwnership` pill would, rather than posting no pill at all.
        let promotedSuccessorUserId: string | null = null;
        let ownerChangedPill: Message | undefined;
        if (participant.role === ConversationRole.Owner) {
          promotedSuccessorUserId = await this.promoteSuccessorInTransaction(
            manager,
            conversationId,
            userId,
          );
          if (promotedSuccessorUserId) {
            ownerChangedPill = await this.insertSystemMessage(
              manager,
              conversationId,
              {
                type: 'owner_changed',
                actorId: userId,
                targetId: promotedSuccessorUserId,
              },
            );
          } else {
            // PRD-357: nobody remains to inherit, so the group ends here, no
            // pill needed (the `member_left` one already narrates it). The
            // dead invite link is cleared, and every still-pending invite is
            // revoked, so nobody can accept/join a group nobody can join,
            // mirroring `dissolveGroup`'s own cleanup exactly.
            const dissolvedAt = new Date();
            await manager.update(
              Conversation,
              { id: conversationId },
              { dissolvedAt, inviteToken: null },
            );
            await manager.update(
              GroupInvite,
              { conversationId, status: GroupInviteStatus.Pending },
              { status: GroupInviteStatus.Revoked, respondedAt: dissolvedAt },
            );
          }
        }
        const systemMessage = await this.insertSystemMessage(
          manager,
          conversationId,
          { type: 'member_left', actorId: userId },
        );
        return {
          systemMessage,
          ownerChangedPill,
          promotedSuccessor: promotedSuccessorUserId != null,
        };
      });

    // Best-effort live fan-out AFTER commit, in the same order the pills were
    // written: the `owner_changed` pill (if any) before `member_left`.
    if (ownerChangedPill) {
      await this.broadcastSystemMessage(ownerChangedPill);
    }
    await this.broadcastSystemMessage(systemMessage);
    // Evict the leaver's sockets from the group room. Room authorisation only
    // ever happens once, at `conversation:join`; without this they keep
    // receiving `message:new`, `typing`, `reaction` and read receipts for a
    // group they are no longer in, until their socket reconnects. Emitted
    // AFTER `broadcastSystemMessage` so they still see the `member_left` pill
    // that is about them.
    this.emitBestEffort(CONVERSATION_MEMBERSHIP_REVOKED, {
      conversationId,
      userIds: [userId],
    } satisfies ConversationMembershipRevokedEvent);
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
   * to member, `left_at` cleared, and `cleared_at` advanced to the later of its
   * old value and that `left_at` so history resumes from the RE-ADD point rather
   * than handing them everything posted while they were out). Posts a
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
    // ENG-239: only the handful of columns this method actually reads/writes
    // (the re-activation branch needs `clearedAt` to compute the resume
    // floor; every other column here is either overwritten outright or used
    // purely for `id`/`userId`/`leftAt`).
    const existingRows = await this.participants.find({
      where: { conversationId },
      select: {
        id: true,
        userId: true,
        leftAt: true,
        clearedAt: true,
        role: true,
      },
    });
    const rowByUser = new Map(existingRows.map((row) => [row.userId, row]));
    const activeMemberUserIds = existingRows
      .filter((row) => row.leftAt == null)
      .map((row) => row.userId);
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
    // PRD-353: seat-or-invite split. A candidate with a PRIOR row here always
    // has `existing.leftAt` set (an active one was already skipped above), so
    // it necessarily means "left or was removed from this exact group",
    // never silently re-seated by a later add, whatever their preference.
    // A candidate with no prior row falls back to their own standing
    // preference: `invite_only` becomes an invite, `connections` (the
    // default) is seated exactly as before. The policy lookup is batched and
    // scoped to ONLY the no-prior-row candidates: a policy that can never
    // change the outcome for a prior-row candidate is not worth a query.
    const candidatesNeedingPolicy = membersToAdd
      .filter(({ existing }) => existing === undefined)
      .map(({ profile }) => profile.userId);
    const policyByUser =
      await this.preferencesService.getGroupAddPolicyForUsers(
        candidatesNeedingPolicy,
      );
    const toSeat: typeof membersToAdd = [];
    const toInvite: typeof membersToAdd = [];
    for (const candidate of membersToAdd) {
      const hasPriorRow = candidate.existing !== undefined;
      const policy = policyByUser.get(candidate.profile.userId);
      if (hasPriorRow || policy === GroupAddPolicy.InviteOnly) {
        toInvite.push(candidate);
      } else {
        toSeat.push(candidate);
      }
    }
    // ENG-239: the active roster plus every candidate actually SEATED must
    // not exceed the cap. A pending invite counts toward the cap only at
    // accept time, not here.
    if (activeMemberUserIds.length + toSeat.length > MAX_GROUP_MEMBERS) {
      throw new ConflictException({
        statusCode: 409,
        message: `A group can have at most ${MAX_GROUP_MEMBERS} members`,
        code: GROUP_FULL_CODE,
      });
    }
    // Batched block + connection gate across ALL candidates (seated AND
    // invited alike): two queries total instead of a sequential pair per
    // handle (N+1). PRD-354: a candidate blocked either way with ANY current
    // active member is refused, not just one blocked with the adder.
    await this.assertAddableMembers(
      actorUserId,
      addedUserIds,
      activeMemberUserIds,
    );

    // Single transaction: every (re)activation/insert, every new invite row,
    // AND the `member_added` pill per seat commit together: a throw mid-loop
    // no longer leaves some members added with no pill / no fan-out.
    const { pills: systemMessages, createdInvites } =
      await this.dataSource.transaction(async (manager) => {
        const pills: Message[] = [];
        if (toSeat.length) {
          // ENG-239: the unlocked pre-transaction count above is only a fast
          // fail, so re-run it under a row lock on the conversation,
          // immediately before seating, so two concurrent writers (another
          // `addMembers`, an `accept`, a link `joinByToken`) racing at the
          // ceiling can never both commit and leave the group over
          // `MAX_GROUP_MEMBERS`; the loser's `GROUP_FULL` throw here rolls
          // its own transaction back.
          await manager.findOne(Conversation, {
            where: { id: conversationId },
            lock: { mode: 'pessimistic_write' },
          });
          const activeCountNow = await manager.count(ConversationParticipant, {
            where: { conversationId, leftAt: IsNull() },
          });
          if (activeCountNow + toSeat.length > MAX_GROUP_MEMBERS) {
            throw new ConflictException({
              statusCode: 409,
              message: `A group can have at most ${MAX_GROUP_MEMBERS} members`,
              code: GROUP_FULL_CODE,
            });
          }
        }
        // A brand-new seat carries its member's own profile identity (the
        // column is NOT NULL); a reactivated row keeps the one it has.
        const newSeatIdentityIdByUserId = await this.profileIdentityIdsByUser(
          manager,
          toSeat
            .filter(({ existing }) => !existing)
            .map(({ profile }) => profile.userId),
        );
        for (const { profile, existing } of toSeat) {
          if (existing) {
            // Re-activation resumes history FROM THE RE-ADD POINT, not from
            // the beginning of the thread. Nulling `clearedAt` outright (as
            // this used to) erased two things at once: the read ceiling that
            // held while they were out — handing a member removed for a period
            // everything said about them in the interim — and their own
            // "delete for me" floor, resurrecting history they had chosen to
            // clear. Carrying the floor forward to the later of the two
            // preserves both: everything they could legitimately see before
            // leaving stays visible, the gap stays hidden.
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
                // Re-seating clears a past removal: a re-added member reads
                // as freshly added, not still "removed". Both columns,
                // together: `removedAt` is the durable record
                // `computeGroupLeftReason`/`joinByToken` actually gate on.
                removedBy: null,
                removedAt: null,
              },
            );
          } else {
            await manager.save(
              manager.create(ConversationParticipant, {
                conversationId,
                userId: profile.userId,
                identityId: newSeatIdentityIdByUserId.get(profile.userId),
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
        // PRD-353: idempotent against the pending unique index: a candidate
        // who already has an open invite on this exact group (e.g. a repeat
        // `addMembers` call naming them again) is left alone rather than
        // producing a second row or a constraint violation.
        const inviteCandidateIds = toInvite.map(
          ({ profile }) => profile.userId,
        );
        const alreadyPendingIds = new Set(
          inviteCandidateIds.length
            ? (
                await manager.find(GroupInvite, {
                  where: {
                    conversationId,
                    inviteeId: In(inviteCandidateIds),
                    status: GroupInviteStatus.Pending,
                  },
                  select: { inviteeId: true },
                })
              ).map((row) => row.inviteeId)
            : [],
        );
        const createdInvites = await manager.save(
          inviteCandidateIds
            .filter((id) => !alreadyPendingIds.has(id))
            .map((inviteeUserId) =>
              manager.create(GroupInvite, {
                conversationId,
                inviteeId: inviteeUserId,
                inviterId: actorUserId,
              }),
            ),
        );
        return { pills, createdInvites };
      });

    // Best-effort live fan-out AFTER commit: one pill per SEATED add, then fan
    // the group to each new member's `user:<id>` room so their inbox
    // refetches live. An invited-only candidate is not yet a participant, so
    // they get no pill and no room fan-out, only the `GROUP_INVITE_CREATED`
    // notification below.
    const seatedUserIds = toSeat.map(({ profile }) => profile.userId);
    for (const systemMessage of systemMessages) {
      await this.broadcastSystemMessage(systemMessage);
    }
    this.emitBestEffort(CONVERSATION_CREATED, {
      conversationId,
      memberUserIds: seatedUserIds,
    } satisfies ConversationCreatedEvent);
    // PRD-334. Same bell row + push as `createGroup`, for exactly the members
    // this write SEATED (the actor, already-active members, and invited
    // candidates were all excluded).
    this.emitBestEffort(GROUP_MEMBERS_ADDED, {
      conversationId,
      actorUserId,
      addedUserIds: seatedUserIds,
    } satisfies GroupMembersAddedEvent);
    // PRD-353. One bell row + push per NEW invite (a re-add that hit the
    // idempotency skip above creates no second notification).
    for (const invite of createdInvites) {
      this.emitBestEffort(GROUP_INVITE_CREATED, {
        conversationId,
        inviteId: invite.id,
        inviteeUserId: invite.inviteeId,
        inviterUserId: actorUserId,
      } satisfies GroupInviteCreatedEvent);
    }
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
      select: { id: true, role: true, leftAt: true },
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
      const removedAt = new Date();
      // `removedAt` is the durable record `computeGroupLeftReason` and
      // `joinByToken`'s REMOVED_FROM_GROUP gate actually read: `removedBy`
      // alone can't anchor either once its `ON DELETE SET NULL` FK fires.
      await manager.update(
        ConversationParticipant,
        { id: target.id },
        { leftAt: removedAt, removedBy: actorUserId, removedAt },
      );
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
    // Cut the removed member's LIVE subscription to the group room — see
    // `leaveGroup` above and {@link CONVERSATION_MEMBERSHIP_REVOKED}. Ordered
    // after the pill + the inbox refetch so their client still learns WHY the
    // thread went read-only.
    this.emitBestEffort(CONVERSATION_MEMBERSHIP_REVOKED, {
      conversationId,
      userIds: [targetUserId],
    } satisfies ConversationMembershipRevokedEvent);
    return this.toGroupConversationResponse(convo, actorUserId);
  }

  /**
   * `PATCH /conversations/:id/members/:userId/role` — OWNER ONLY. Promotes a
   * member→admin or demotes an admin→member (the `owner` role can't be assigned
   * here, succession is separate). PRD-355: posts a `member_promoted`/
   * `member_demoted` pill and fans a refetch so every member's role badges +
   * can-flags update live. SERVER-AUTHORITATIVE.
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
      select: { id: true, role: true, leftAt: true },
    });
    if (!target || target.leftAt) {
      throw new NotFoundException('That member is not in this group');
    }
    if (target.role === ConversationRole.Owner) {
      throw new ForbiddenException('The owner role cannot be changed here');
    }
    if (target.role !== role) {
      const systemMessage = await this.dataSource.transaction(
        async (manager) => {
          await manager.update(
            ConversationParticipant,
            { id: target.id },
            { role },
          );
          return this.insertSystemMessage(manager, conversationId, {
            type:
              role === ConversationRole.Admin
                ? 'member_promoted'
                : 'member_demoted',
            actorId: actorUserId,
            targetId: targetUserId,
          });
        },
      );
      await this.broadcastSystemMessage(systemMessage);
      await this.fanGroupRefresh(conversationId);
    }
    return this.toGroupConversationResponse(convo, actorUserId);
  }

  /**
   * `PATCH /conversations/:id` (title/avatar/description): owner/admin edits
   * the group's info. Each changed field posts its OWN pill (PRD-355: a title
   * change keeps `group_renamed`; an avatar change now posts
   * `group_photo_changed` instead of a quiet refetch; a description change
   * posts `group_description_changed`); a PATCH touching more than one field
   * posts one pill per field, not a single combined one. `avatarUrl` reuses
   * the storage-key plumbing already threaded end-to-end (no new upload
   * pipeline is built here, see the group-chat note). SERVER-AUTHORITATIVE
   * role re-check.
   */
  async updateGroup(
    conversationId: string,
    actorUserId: string,
    changes: {
      title?: string;
      avatarUrl?: string | null;
      description?: string;
    },
  ): Promise<ConversationResponse> {
    const { convo } = await this.requireGroupRole(
      conversationId,
      actorUserId,
      ConversationRole.Admin,
    );
    // Shared-upload backstop (see `assertNoForeignUploadIntroduced`): a group is
    // edited by any of its owners/admins, so the interceptor exempts it and lets
    // an admin re-save the currently stored photo whoever uploaded it. Runs
    // BEFORE any mutation and draws the line the interceptor cannot: a foreign
    // photo is allowed only when it is already the stored value, so an admin
    // cannot point the field at a new foreign upload.
    assertNoForeignUploadIntroduced(actorUserId, changes.avatarUrl, [
      convo.avatarUrl,
    ]);
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
    // PRD-358: sanitised to plain text the same way an attachment caption is
    // (`toStoredPlainTextOrNull`), so the about text can never carry markup.
    // `""` clears it back to null.
    let descriptionChanged = false;
    if (changes.description !== undefined) {
      const next = toStoredPlainTextOrNull(changes.description);
      if (next !== convo.description) {
        convo.description = next;
        descriptionChanged = true;
      }
    }
    if (renamed || avatarChanged || descriptionChanged) {
      // Targeted UPDATE, never a full-row `save()` of the `convo` that
      // `requireGroupRole` loaded above, at the START of this request: a
      // concurrent `createOrRotateInviteLink`/`disableInviteLink`/
      // `dissolveGroup` committing in between would otherwise be silently
      // reverted by this row's own stale copy of `inviteToken`/
      // `dissolvedAt`, un-ending a group or reviving a stale invite link.
      await this.conversations.update(
        { id: conversationId },
        {
          ...(renamed && { title: convo.title }),
          ...(avatarChanged && { avatarUrl: convo.avatarUrl }),
          ...(descriptionChanged && { description: convo.description }),
        },
      );
    }
    // Each pill is best effort: the row write above already committed, so a
    // failure narrating ONE change (e.g. `group_renamed`) must not 500 the
    // whole PATCH or skip the remaining pills for changes that DID apply.
    if (renamed) {
      await this.postSystemMessageBestEffort(conversationId, {
        type: 'group_renamed',
        actorId: actorUserId,
        value: convo.title ?? undefined,
      });
    }
    if (avatarChanged) {
      await this.postSystemMessageBestEffort(conversationId, {
        type: 'group_photo_changed',
        actorId: actorUserId,
      });
    }
    if (descriptionChanged) {
      await this.postSystemMessageBestEffort(conversationId, {
        type: 'group_description_changed',
        actorId: actorUserId,
      });
    }
    return this.toGroupConversationResponse(convo, actorUserId);
  }

  /**
   * `POST /conversations/:id/owner`: OWNER ONLY (DES-228). Transfers
   * ownership to an active member: the target becomes `owner`, the caller
   * (the outgoing owner) becomes `admin`, in ONE transaction with the
   * `owner_changed` pill (actor = the previous owner, target = the new
   * owner). SERVER-AUTHORITATIVE role re-check.
   */
  async transferOwnership(
    conversationId: string,
    actorUserId: string,
    targetUserId: string,
  ): Promise<ConversationResponse> {
    const { participant: actor, convo } = await this.requireGroupRole(
      conversationId,
      actorUserId,
      ConversationRole.Owner,
    );
    if (targetUserId === actorUserId) {
      throw new BadRequestException('You are already the owner');
    }
    const target = await this.participants.findOne({
      where: { conversationId, userId: targetUserId },
      select: { id: true, leftAt: true },
    });
    if (!target || target.leftAt) {
      throw new NotFoundException('That member is not in this group');
    }
    const systemMessage = await this.dataSource.transaction(async (manager) => {
      await manager.update(
        ConversationParticipant,
        { id: target.id },
        { role: ConversationRole.Owner },
      );
      await manager.update(
        ConversationParticipant,
        { id: actor.id },
        { role: ConversationRole.Admin },
      );
      return this.insertSystemMessage(manager, conversationId, {
        type: 'owner_changed',
        actorId: actorUserId,
        targetId: targetUserId,
      });
    });
    await this.broadcastSystemMessage(systemMessage);
    await this.fanGroupRefresh(conversationId);
    return this.toGroupConversationResponse(convo, actorUserId);
  }

  /**
   * `POST /conversations/:id/dissolve`: OWNER ONLY (PRD-357). Ends the group
   * for everyone in ONE transaction: the `group_dissolved` pill is written
   * FIRST, `dissolved_at` is stamped to that pill's own `created_at` (so
   * `computeGroupLeftReason` always sees the pill as having landed before the
   * severance it explains), then every currently active participant
   * (including the owner who dissolved it) gets `left_at` set to strictly
   * AFTER the pill, the invite link is cleared, and any pending invite is
   * `revoked`. `requireGroupRole` above already refuses a group dissolved a
   * second time with `GROUP_DISSOLVED`. Post-commit: the pill broadcasts, and
   * every formerly-active member gets the same inbox-refresh + room-eviction
   * pair every other membership change uses.
   */
  async dissolveGroup(
    conversationId: string,
    actorUserId: string,
  ): Promise<ConversationResponse> {
    const { convo } = await this.requireGroupRole(
      conversationId,
      actorUserId,
      ConversationRole.Owner,
    );
    const { systemMessage, memberUserIds } = await this.dataSource.transaction(
      async (manager) => {
        const activeRows = await manager.find(ConversationParticipant, {
          where: { conversationId, leftAt: IsNull() },
          select: { userId: true },
        });
        const memberUserIds = activeRows.map((row) => row.userId);
        const systemMessage = await this.insertSystemMessage(
          manager,
          conversationId,
          { type: 'group_dissolved', actorId: actorUserId },
        );
        const leftAt = new Date(systemMessage.createdAt.getTime() + 1);
        await manager.update(
          Conversation,
          { id: conversationId },
          { dissolvedAt: systemMessage.createdAt, inviteToken: null },
        );
        if (memberUserIds.length) {
          await manager.update(
            ConversationParticipant,
            { conversationId, leftAt: IsNull() },
            { leftAt },
          );
        }
        await manager.update(
          GroupInvite,
          { conversationId, status: GroupInviteStatus.Pending },
          { status: GroupInviteStatus.Revoked, respondedAt: leftAt },
        );
        return { systemMessage, memberUserIds };
      },
    );
    // Mirror the transaction's own writes onto the in-memory `convo` so the
    // response built below (which re-reads participants from the DB, but not
    // the conversation row) reflects the dissolve without a second fetch.
    convo.dissolvedAt = systemMessage.createdAt;
    convo.inviteToken = null;

    await this.broadcastSystemMessage(systemMessage);
    this.emitBestEffort(CONVERSATION_CREATED, {
      conversationId,
      memberUserIds,
    } satisfies ConversationCreatedEvent);
    this.emitBestEffort(CONVERSATION_MEMBERSHIP_REVOKED, {
      conversationId,
      userIds: memberUserIds,
    } satisfies ConversationMembershipRevokedEvent);
    return this.toGroupConversationResponse(convo, actorUserId);
  }

  /**
   * `POST /conversations/:id/invite-link`: owner/admin (PRD-358). Creates the
   * group's join-by-link token, or ROTATES it (a fresh random token
   * invalidates whichever one was live): 32 random bytes, base64url-encoded,
   * url-safe with no padding, so it drops straight into a shareable link with
   * no further escaping. No QR code (PRD-359 deferred): the token itself is
   * the whole feature.
   */
  async createOrRotateInviteLink(
    conversationId: string,
    actorUserId: string,
  ): Promise<{ inviteToken: string }> {
    await this.requireGroupRole(
      conversationId,
      actorUserId,
      ConversationRole.Admin,
    );
    const inviteToken = randomBytes(32).toString('base64url');
    await this.conversations.update({ id: conversationId }, { inviteToken });
    // Two concurrent rotations can both commit here, and only the LAST write
    // is actually live, so re-read rather than trust the token THIS call
    // generated, so a caller who lost the race is told the truth (the
    // token that is really shareable) instead of one nobody can join with.
    const persisted = await this.conversations.findOne({
      where: { id: conversationId },
      select: { inviteToken: true },
    });
    return { inviteToken: persisted?.inviteToken ?? inviteToken };
  }

  /**
   * `DELETE /conversations/:id/invite-link`: owner/admin (PRD-358). Disables
   * the group's join-by-link, if any: a stale/shared link 404s the next
   * `GET join/:token` with `INVITE_LINK_INVALID` rather than staying live
   * forever.
   */
  async disableInviteLink(
    conversationId: string,
    actorUserId: string,
  ): Promise<void> {
    await this.requireGroupRole(
      conversationId,
      actorUserId,
      ConversationRole.Admin,
    );
    await this.conversations.update(
      { id: conversationId },
      { inviteToken: null },
    );
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
    // PRD-357: a dissolved group is read-only for every write past this gate
    // (add, remove, role, owner transfer, rename/photo/description, and a
    // repeat dissolve). Checked before `leftAt` so calling this on an already
    // dissolved group (where every participant's `leftAt` is now also set)
    // reports the specific, actionable `GROUP_DISSOLVED` rather than the
    // generic "You have left this group".
    if (convo.dissolvedAt) {
      throw new ForbiddenException({
        statusCode: 403,
        message: 'This group has ended',
        code: GROUP_DISSOLVED_CODE,
      });
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
   * member), ties broken deterministically by participant id. Returns the
   * successor's user id (so the caller can post the `owner_changed` pill and
   * fan a quiet refetch AFTER commit), or `null` when nobody remains, which
   * leaves the group ownerless and is the caller's cue to dissolve instead.
   */
  private async promoteSuccessorInTransaction(
    manager: EntityManager,
    conversationId: string,
    leavingUserId: string,
  ): Promise<string | null> {
    const rows = await manager.find(ConversationParticipant, {
      where: { conversationId },
      select: { id: true, userId: true, leftAt: true, role: true },
    });
    const [successor] = rows
      .filter((row) => row.leftAt == null && row.userId !== leavingUserId)
      .sort(
        (a, b) =>
          ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.id.localeCompare(b.id),
      );
    if (!successor) {
      return null;
    }
    await manager.update(
      ConversationParticipant,
      { id: successor.id },
      { role: ConversationRole.Owner },
    );
    return successor.userId;
  }

  /**
   * Fan a `conversation:new` (inbox refetch) to every ACTIVE member's user room —
   * for group mutations that post no system message (role change, avatar-only
   * edit, succession) so every member's roster/can-flags/photo refresh live.
   */
  private async fanGroupRefresh(conversationId: string): Promise<void> {
    const rows = await this.participants.find({
      where: { conversationId },
      select: { userId: true, leftAt: true },
    });
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
   * Persist a `system` message and broadcast it (via `broadcastPill` →
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
    await this.broadcastPill(saved);
  }

  /**
   * Best-effort wrapper around `postSystemMessage` for a caller whose OWN
   * write already committed (`updateGroup`'s targeted `conversations.update`
   * above): a pill is a narration of a durable change, not part of it, so a
   * failure inserting or broadcasting ONE pill must neither 500 an already-
   * successful PATCH nor stop the remaining pills for the other changed
   * fields from posting.
   */
  private async postSystemMessageBestEffort(
    conversationId: string,
    event: SystemEvent,
  ): Promise<void> {
    try {
      await this.postSystemMessage(conversationId, event);
    } catch {
      // best-effort: the field write already committed; a pill failure is benign.
    }
  }

  /**
   * Each member's own profile identity, for the seats `createGroup` and
   * `addMembers` insert (`conversation_participants.identity_id` is NOT
   * NULL). One read through the caller's transaction covers the whole batch.
   * A member with no profile identity row yet, someone who joined after the
   * backfill and never sent a message, gets one through
   * `IdentitiesService.resolveProfileIdentityId`, the same get-or-create the
   * pills use, so every requested user id is present in the result.
   */
  private async profileIdentityIdsByUser(
    manager: EntityManager,
    userIds: string[],
  ): Promise<Map<string, string>> {
    const uniqueUserIds = [...new Set(userIds)];
    const identityIdByUserId = new Map<string, string>();
    if (uniqueUserIds.length === 0) {
      return identityIdByUserId;
    }
    const profileIdentities = await manager.find(Identity, {
      where: { kind: IdentityKind.Profile, userId: In(uniqueUserIds) },
      select: { id: true, userId: true },
    });
    for (const identity of profileIdentities) {
      if (identity.userId) {
        identityIdByUserId.set(identity.userId, identity.id);
      }
    }
    for (const userId of uniqueUserIds) {
      if (!identityIdByUserId.has(userId)) {
        identityIdByUserId.set(
          userId,
          await this.identities.resolveProfileIdentityId(userId),
        );
      }
    }
    return identityIdByUserId;
  }

  /**
   * Persist a `system` message row using the supplied `manager` — the pure
   * INSERT with no broadcast, so it can run INSIDE a transaction (createGroup /
   * leaveGroup / addMembers / removeMember) and have its MESSAGE_CREATED
   * fan-out deferred to after commit via `broadcastSystemMessage`. `body` is a
   * plain-text fallback for consumers that don't understand the structured
   * event.
   *
   * Task 8: `CHK_messages_sender_identity` requires `senderIdentityId`
   * whenever `senderId` is set. A pill reading "Tiago added Cy" is authored
   * by Tiago acting as themselves, so it stamps the actor's own profile
   * identity, resolved through `IdentitiesService` (idempotent get-or-create,
   * so this stays correct even for an actor whose identity row is created
   * here for the first time).
   *
   * `resolvedActorIdentityId` lets a caller that already resolved the same
   * actor's profile identity earlier in the same request (`createGroup`'s
   * reply-only guard) pass it straight through, saving a second, redundant
   * resolve of the exact same identity.
   */
  private async insertSystemMessage(
    manager: EntityManager,
    conversationId: string,
    event: SystemEvent,
    resolvedActorIdentityId?: string,
  ): Promise<Message> {
    const senderIdentityId =
      resolvedActorIdentityId ??
      (await this.identities.resolveProfileIdentityId(event.actorId));
    return manager.save(
      manager.create(Message, {
        conversationId,
        senderId: event.actorId,
        senderIdentityId,
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
      await this.broadcastPill(message);
    } catch {
      // best-effort: the pill persisted; a live relay failure is benign.
    }
  }

  /**
   * The one spelling every system-pill broadcast in this service uses to build
   * the frontend-contract `MessageResponse` and fan `MESSAGE_CREATED` to the
   * room. Deliberately does NOT call `core.buildPostResult` with `emit: true`:
   * that helper computes `systemEvent.actorIsMe`/`targetIsMe` for a SINGLE
   * viewer (the actor, the only id it's handed) and would broadcast that exact
   * response to every member's socket verbatim: every member's client would
   * then render the ACTOR's own "you" framing ("You made Cy an admin" shown to
   * Cy, to the group, to a member who did nothing). Correct for a later
   * per-caller `GET /messages` read (which re-runs `toMessageResponses` with
   * the REAL viewer each time); wrong for a shared broadcast copy. Both flags
   * are stripped to `undefined` on the copy that goes out over the wire;
   * `systemEvent.actorHandle`/`targetHandle` (public, always present) are what
   * `buildSystemEvent`'s own doc says a broadcast copy should let each client
   * derive "is this me" from instead. Each recipient's next fetch of this
   * conversation recomputes the flags correctly for them regardless.
   */
  private async broadcastPill(message: Message): Promise<void> {
    // A system message's true actor always lives in its own `systemEvent`
    // (never erased, it's a plain uuid in jsonb); `senderId` is read only as
    // a defensive fallback, since ENG-243 can later null it on the column.
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
    // Mirrors `buildPostResult`'s own `emit: true` unarchive step: a fresh
    // pill is exactly the "something new happened" a participant's archive
    // should not silently swallow.
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
   * Group member-gate for a batch of candidate user ids: PRD-354 refuses a
   * candidate blocked either way with the adder OR with ANY currently active
   * member (`guardianUserIds`: the adder plus, for `addMembers`, the active
   * roster; just the adder for `createGroup`, which has no other members
   * yet), with copy that never names who blocked whom on either side. Each
   * candidate must also be an accepted connection of the actor. Three queries
   * total regardless of candidate/guardian count (batched multi-actor block
   * set + the accepted-connection subset among exactly these candidates),
   * replacing the previous per-candidate `isBlockedEitherWay` + `areConnected`
   * pair (N+1). Block is checked before connection per candidate, matching
   * the previous sequential precedence.
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
    guardianUserIds: string[] = [actorUserId],
  ): Promise<void> {
    if (!candidateUserIds.length) {
      return;
    }
    const [blockedAgainstAnyGuardian, connectedUserIds] = await Promise.all([
      this.blockFilter.blockedAgainstAnyOf(candidateUserIds, guardianUserIds),
      this.connectionsService.acceptedConnectionsAmong(
        actorUserId,
        candidateUserIds,
      ),
    ]);
    for (const candidateUserId of candidateUserIds) {
      if (blockedAgainstAnyGuardian.has(candidateUserId)) {
        // Generic on purpose (PRD-354): never reveals which side blocked
        // which, or whether it was the adder or another member.
        throw new ForbiddenException({
          statusCode: 403,
          message: 'That member cannot be added to this group right now',
          code: GROUP_ADD_REFUSED_CODE,
        });
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
      this.core.lastMessagesByConversation([convo.id], userId),
      this.core.unreadCountsByConversation([convo.id], userId),
    ]);
    const callerRow = participantRows.find((row) => row.userId === userId);
    const profiles = await this.profiles.find({
      where: { userId: In(participantRows.map((row) => row.userId)) },
    });
    const profileByUser = new Map(profiles.map((p) => [p.userId, p]));
    // PRD-364: reciprocal read-receipt sharing — see `ConversationsService
    // .listConversations`'s identical batched fetch.
    const privacyByUser =
      await this.preferencesService.getMessagingPrivacyForUsers(
        participantRows.map((row) => row.userId),
      );
    // ENG-238: a caller who has left (voluntarily, removed, or the group was
    // dissolved) gets NO roster and NO per-member watermarks: a severed
    // member reads history but must not keep learning who else is (or was
    // ever) in the group, or when they last read something. `memberCount`
    // stays accurate (a bare number leaks nothing) and is computed
    // independently rather than derived from `members.length`.
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
    // PRD-348: batched (one conversation here, but the same shared helper the
    // inbox list uses). See `MessagingCoreService.hasUnreadMentionByConversation`.
    const mentionByConvo = await this.core.hasUnreadMentionByConversation(
      [convo.id],
      userId,
      profileByUser.get(userId)?.slug,
    );
    // PRD-353: an owner/admin of an active, non-dissolved group sees who has
    // been invited and not yet answered; everyone else gets `[]`, same gate
    // as `canManageInviteLink` below.
    const canSeePendingInvites =
      !hasCallerLeft &&
      !convo.dissolvedAt &&
      (callerRow?.role === ConversationRole.Owner ||
        callerRow?.role === ConversationRole.Admin);
    const pendingInviteRows = canSeePendingInvites
      ? await this.groupInvites.find({
          where: {
            conversationId: convo.id,
            status: GroupInviteStatus.Pending,
          },
          order: { createdAt: 'ASC' },
        })
      : [];
    const inviteeProfiles = pendingInviteRows.length
      ? await this.profiles.find({
          where: { userId: In(pendingInviteRows.map((row) => row.inviteeId)) },
        })
      : [];
    const inviteeProfileByUser = new Map(
      inviteeProfiles.map((p) => [p.userId, p]),
    );
    const pendingInvites = pendingInviteRows.map((invite) => {
      const inviteeSummary = requireAuthorSummary(
        inviteeProfileByUser.get(invite.inviteeId),
      );
      return {
        id: invite.id,
        user: {
          id: invite.inviteeId,
          handle: inviteeSummary.handle,
          name: inviteeSummary.displayName,
          avatarUrl: inviteeSummary.avatarUrl,
        },
        createdAt: invite.createdAt.toISOString(),
      };
    });

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
      // The connection gate (PRD-220) never applies to a group thread — see
      // `ConversationsService.listConversations`' matching field.
      replyRequiresConnection: false,
      // DES-225: "Connected since" is a DM-only fact.
      connectedSince: null,
      kind: 'group',
      title: convo.title,
      avatarUrl: toImageUrl(convo.avatarUrl),
      avatarCrop: cropFor(convo.avatarUrl, avatarCrops),
      memberCount: activeMemberCount,
      members,
      // ENG-253: populated on EVERY response (unlike `members`, which ENG-238
      // empties out once the caller has left), see `ConversationMemberPreview`'s
      // own doc. Reuses `buildMemberPreview`, the same active-members-only,
      // `MAX_MEMBER_PREVIEW`-capped helper the list path calls (unconditionally,
      // regardless of the caller's own `leftAt`), instead of a parallel
      // capped-slice.
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
      // Only an active (not-left, not-dissolved) owner/admin ever sees the
      // live token; everyone else gets null even if one exists.
      inviteToken:
        !callerRow?.leftAt &&
        !convo.dissolvedAt &&
        (callerRow?.role === ConversationRole.Owner ||
          callerRow?.role === ConversationRole.Admin)
          ? convo.inviteToken
          : null,
      // Owner/admin only, active, not dissolved (`canDissolve`/
      // `canTransferOwnership` are OWNER only: an admin can manage the
      // invite link but never end or hand off the group).
      canManageInviteLink:
        !hasCallerLeft &&
        !convo.dissolvedAt &&
        (callerRow?.role === ConversationRole.Owner ||
          callerRow?.role === ConversationRole.Admin),
      canTransferOwnership:
        !hasCallerLeft &&
        !convo.dissolvedAt &&
        callerRow?.role === ConversationRole.Owner,
      canDissolve:
        !hasCallerLeft &&
        !convo.dissolvedAt &&
        callerRow?.role === ConversationRole.Owner,
      pendingInvites,
      ...this.core.groupCapabilities(callerRow?.role, hasCallerLeft),
    };
  }
}
