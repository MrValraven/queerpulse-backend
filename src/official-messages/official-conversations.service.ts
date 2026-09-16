import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { MessagingCoreService } from '../messaging/messaging-core.service';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import { Profile } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import {
  OFFICIAL_MESSAGE_SENT_ACTION,
  OFFICIAL_RECIPIENT_NOT_FOUND_CODE,
  OFFICIAL_SENDER_EMAIL,
  OFFICIAL_SENDER_FIRST_NAME,
  OFFICIAL_SENDER_GOOGLE_ID,
  OFFICIAL_SENDER_LAST_NAME,
} from './official-messages.constants';
import {
  OfficialMessageSentResponse,
  toOfficialMessageSentResponse,
} from './official-messages-response';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/**
 * PRD-372: the official thread, one per member, and the single way to post
 * into it.
 *
 * WHAT AN OFFICIAL THREAD IS (matching every existing reader):
 * - a `conversations` row with `kind = direct`, `is_official = true`, no
 *   `pair_key`, and `official_member_id` = the member it belongs to;
 * - ONE participant: that member. The sender (the house account) is
 *   deliberately NOT a participant, so it never accumulates a platform-sized
 *   inbox and nothing ever treats it as the thread's "other participant"
 *   (`ConversationsService.listConversations` already renders official rows
 *   with no counterpart, as the org identity);
 * - exempt from the block and connection gates, rendered as `type: 'group'`,
 *   push-suppressed by `PushMessageListener`. None of that changes here, and
 *   the member's own send rule is untouched (the server still accepts a reply;
 *   the client severs the composer).
 *
 * Posting goes through `MessagingCoreService.postMessage`, the same write path
 * a member's message takes, so `message:new`, the per-member
 * `conversation:message` fan-out, unarchiving, inbox ordering and unread
 * counts all behave exactly as for any message.
 */
@Injectable()
export class OfficialConversationsService {
  private readonly logger = new Logger(OfficialConversationsService.name);
  /** Resolved once per process; the house account id never changes. */
  private officialSenderId: string | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(ModAuditLog)
    private readonly auditLogs: Repository<ModAuditLog>,
    private readonly usersService: UsersService,
    private readonly core: MessagingCoreService,
  ) {}

  /**
   * The house account's user id. Genesis creates it on every real platform;
   * a database that never ran genesis (a local seed, a fresh test DB) gets it
   * created here, idempotently, with exactly the identity genesis would have
   * used. A concurrent first use loses the `users.google_id` unique race and
   * reads the winner back.
   */
  async resolveOfficialSenderId(): Promise<string> {
    if (this.officialSenderId) return this.officialSenderId;
    const existing = await this.users.findOne({
      where: { googleId: OFFICIAL_SENDER_GOOGLE_ID },
      select: { id: true },
    });
    if (existing) {
      this.officialSenderId = existing.id;
      return existing.id;
    }
    try {
      const created = await this.dataSource.transaction((manager) =>
        this.usersService.createGoogleUser(manager, {
          googleId: OFFICIAL_SENDER_GOOGLE_ID,
          email: OFFICIAL_SENDER_EMAIL,
          firstName: OFFICIAL_SENDER_FIRST_NAME,
          lastName: OFFICIAL_SENDER_LAST_NAME,
          status: UserStatus.Active,
          isSystem: true,
        }),
      );
      this.logger.log('Created the house account as the official sender');
      this.officialSenderId = created.id;
      return created.id;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const winner = await this.users.findOneOrFail({
        where: { googleId: OFFICIAL_SENDER_GOOGLE_ID },
        select: { id: true },
      });
      this.officialSenderId = winner.id;
      return winner.id;
    }
  }

  /** Exactly one official thread for this member; created on first use. */
  async getOrCreateOfficialConversation(memberId: string): Promise<string> {
    const conversationIdByMember = await this.getOrCreateOfficialConversations([
      memberId,
    ]);
    const conversationId = conversationIdByMember.get(memberId);
    if (!conversationId) {
      throw new NotFoundException({
        statusCode: 404,
        message: 'Member not found',
        code: OFFICIAL_RECIPIENT_NOT_FOUND_CODE,
      });
    }
    return conversationId;
  }

  /**
   * Batched form for broadcast delivery: three statements for any number of
   * members, never one round trip per member.
   *
   * Race-safe by construction: `ON CONFLICT DO NOTHING` against the partial
   * unique index `UQ_conversations_official_member` means a concurrent
   * creator never errors and never makes a second row; the SELECT that
   * follows reads whichever row won. The participant insert is equally
   * idempotent (`UQ_conversation_participants`) and runs for existing threads
   * too, so a thread left without its participant row heals itself. All three
   * run in one transaction.
   */
  async getOrCreateOfficialConversations(
    memberIds: string[],
  ): Promise<Map<string, string>> {
    const uniqueMemberIds = [...new Set(memberIds)];
    if (uniqueMemberIds.length === 0) return new Map();
    return this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO "conversations" ("is_official", "official_member_id")
         SELECT true, member.id
         FROM "users" member
         WHERE member.id = ANY($1::uuid[]) AND member.is_system = false
         ON CONFLICT ("official_member_id") WHERE "official_member_id" IS NOT NULL
         DO NOTHING`,
        [uniqueMemberIds],
      );
      const rows: { id: string; official_member_id: string }[] =
        await manager.query(
          `SELECT "id", "official_member_id" FROM "conversations"
           WHERE "official_member_id" = ANY($1::uuid[])`,
          [uniqueMemberIds],
        );
      if (rows.length > 0) {
        await manager.query(
          `INSERT INTO "conversation_participants" ("conversation_id", "user_id")
           SELECT pair.conversation_id, pair.user_id
           FROM unnest($1::uuid[], $2::uuid[]) AS pair(conversation_id, user_id)
           ON CONFLICT ("conversation_id", "user_id") DO NOTHING`,
          [
            rows.map((row) => row.id),
            rows.map((row) => row.official_member_id),
          ],
        );
      }
      return new Map(rows.map((row) => [row.official_member_id, row.id]));
    });
  }

  /**
   * Admin posts one official message to one member. The recipient must exist
   * and be a person (never the house account itself). Their status is not
   * gated: a safety notice to a suspended member is exactly the kind of
   * message this exists for, and they read it when they are next let in.
   */
  async postOfficialMessage(
    memberId: string,
    body: string,
    actorId: string,
  ): Promise<OfficialMessageSentResponse> {
    const recipient = await this.users.findOne({
      where: { id: memberId },
      select: { id: true, isSystem: true },
    });
    if (!recipient || recipient.isSystem) {
      throw new NotFoundException({
        statusCode: 404,
        message: 'Member not found',
        code: OFFICIAL_RECIPIENT_NOT_FOUND_CODE,
      });
    }
    const senderId = await this.resolveOfficialSenderId();
    const conversationId = await this.getOrCreateOfficialConversation(memberId);
    const { response } = await this.core.postMessage(
      conversationId,
      senderId,
      body,
    );
    const recipientProfile = await this.profiles.findOne({
      where: { userId: memberId },
      select: { userId: true, firstName: true, lastName: true },
    });
    await this.writeAudit({
      actorId,
      action: OFFICIAL_MESSAGE_SENT_ACTION,
      targetUserId: memberId,
      targetName: recipientProfile
        ? `${recipientProfile.firstName} ${recipientProfile.lastName}`.trim()
        : null,
      note: body,
    });
    return toOfficialMessageSentResponse({
      conversationId,
      messageId: response.id,
      recipientId: memberId,
      createdAt: response.createdAt,
    });
  }

  /**
   * Writes the immutable audit row straight to the `ModAuditLog` repository.
   * `ModAuditService.writeAuditLog` has no `targetUserId` /
   * `targetName`, and an official message's trail must say WHO it went to.
   * Same entity, same columns, same append-only semantics; it also avoids
   * importing the whole `ModerationModule` graph for one insert.
   */
  async writeAudit(input: {
    actorId: string;
    action: string;
    targetUserId?: string | null;
    targetName?: string | null;
    note: string;
  }): Promise<void> {
    await this.auditLogs.save(
      this.auditLogs.create({
        reportId: null,
        actorId: input.actorId,
        action: input.action,
        targetUserId: input.targetUserId ?? null,
        targetName: input.targetName ?? null,
        reasonCode: null,
        note: input.note,
        duration: null,
      }),
    );
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    (error.driverError as { code?: string } | undefined)?.code ===
      UNIQUE_VIOLATION
  );
}
