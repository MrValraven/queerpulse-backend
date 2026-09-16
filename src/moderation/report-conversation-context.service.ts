import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, SelectQueryBuilder } from 'typeorm';
import { Message } from '../messaging/entities/message.entity';
import { Report, ReportSubjectType } from '../reports/entities/report.entity';
import { messageSnapshotFrom } from '../reports/report-evidence';
import { Profile } from '../users/entities/profile.entity';
import { ModAuditService } from './mod-audit.service';
import {
  CONVERSATION_CONTEXT_UNAVAILABLE_CODE,
  CONVERSATION_CONTEXT_VIEWED_AUDIT_ACTION,
  CONVERSATION_CONTEXT_WINDOW_SIZE,
  ReportConversationContextDTO,
  toConversationContextMessage,
} from './report-conversation-context-response';

// `reports.subject_id` is a client-supplied `varchar`; `messages.id` is `uuid`.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Row-value comparison against the anchor row itself, so the window splits at
 *  the database's exact microsecond `created_at` rather than a millisecond
 *  JavaScript `Date` that could misplace same-millisecond neighbours. */
const ANCHOR_ROW = `(SELECT anchor.created_at, anchor.id FROM messages anchor WHERE anchor.id = :anchorMessageId)`;

/**
 * PRD-360: the staff conversation viewer.
 *
 * A moderator judging a message report used to see one line with no prior
 * messages, so grooming, escalation and reply-baiting were invisible and an
 * out-of-context report could not be exonerated. This opens up to
 * {@link CONVERSATION_CONTEXT_WINDOW_SIZE} messages on each side of the reported
 * one, resolved entirely from the report (the caller names a report, never a
 * conversation), and writes one `conversation_context_viewed` audit row per
 * opening. The participants are not notified: the report is the trigger.
 *
 * Staff read the conversation as it is stored, which is exactly why every
 * opening is audited: a tombstone shows as deleted with no body (the reported
 * message excepted), a sender who erased their account shows as a former
 * member, and nothing here is filtered by the moderator's own membership.
 */
@Injectable()
export class ReportConversationContextService {
  constructor(
    @InjectRepository(Report) private readonly reports: Repository<Report>,
    @InjectRepository(Message) private readonly messages: Repository<Message>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly audit: ModAuditService,
  ) {}

  async getContext(
    reportId: string,
    actorId: string,
  ): Promise<ReportConversationContextDTO> {
    const report = await this.reports.findOne({
      where: { id: reportId },
      select: { id: true, subjectType: true, subjectId: true, evidence: true },
    });
    if (!report) {
      throw new NotFoundException('Report not found');
    }
    if (
      report.subjectType !== ReportSubjectType.Message ||
      !UUID_RE.test(report.subjectId)
    ) {
      throw this.unavailable();
    }
    const reportedMessage = await this.messages.findOne({
      where: { id: report.subjectId },
      withDeleted: true,
      select: { id: true, conversationId: true },
    });
    if (!reportedMessage) {
      throw this.unavailable();
    }
    const { conversationId } = reportedMessage;

    const [earlierRowsNewestFirst, anchorAndLaterRows] = await Promise.all([
      this.windowQuery(conversationId, reportedMessage.id)
        .andWhere(`(message.created_at, message.id) < ${ANCHOR_ROW}`)
        .orderBy('message.createdAt', 'DESC')
        .addOrderBy('message.id', 'DESC')
        // One extra row answers `hasEarlierMessages` without a count.
        .limit(CONVERSATION_CONTEXT_WINDOW_SIZE + 1)
        .getMany(),
      this.windowQuery(conversationId, reportedMessage.id)
        .andWhere(`(message.created_at, message.id) >= ${ANCHOR_ROW}`)
        .orderBy('message.createdAt', 'ASC')
        .addOrderBy('message.id', 'ASC')
        // The anchor, the window after it, and one probe row.
        .limit(CONVERSATION_CONTEXT_WINDOW_SIZE + 2)
        .getMany(),
    ]);

    const hasEarlierMessages =
      earlierRowsNewestFirst.length > CONVERSATION_CONTEXT_WINDOW_SIZE;
    const hasLaterMessages =
      anchorAndLaterRows.length > CONVERSATION_CONTEXT_WINDOW_SIZE + 1;
    const windowMessages = [
      ...earlierRowsNewestFirst
        .slice(0, CONVERSATION_CONTEXT_WINDOW_SIZE)
        .reverse(),
      ...anchorAndLaterRows.slice(0, CONVERSATION_CONTEXT_WINDOW_SIZE + 1),
    ];

    const profileByUserId = await this.profilesFor(windowMessages);
    const reportedSnapshot = messageSnapshotFrom(report.evidence);

    await this.audit.writeAuditLog(
      report.id,
      actorId,
      CONVERSATION_CONTEXT_VIEWED_AUDIT_ACTION,
      undefined,
      `Opened ${windowMessages.length} messages around message ${reportedMessage.id} in conversation ${conversationId}`,
    );

    return {
      reportId: report.id,
      conversationId,
      reportedMessageId: reportedMessage.id,
      hasEarlierMessages,
      hasLaterMessages,
      messages: windowMessages.map((message) =>
        toConversationContextMessage(
          message,
          profileByUserId,
          reportedMessage.id,
          reportedSnapshot,
        ),
      ),
    };
  }

  /** Every stored row of the conversation, tombstones included. */
  private windowQuery(
    conversationId: string,
    anchorMessageId: string,
  ): SelectQueryBuilder<Message> {
    return this.messages
      .createQueryBuilder('message')
      .withDeleted()
      .where('message.conversationId = :conversationId', { conversationId })
      .setParameter('anchorMessageId', anchorMessageId);
  }

  /** One batched profile read for every sender in the window. */
  private async profilesFor(
    windowMessages: Message[],
  ): Promise<Map<string, Profile>> {
    const senderIds = [
      ...new Set(
        windowMessages
          .map((message) => message.senderId)
          .filter((senderId): senderId is string => Boolean(senderId)),
      ),
    ];
    if (!senderIds.length) {
      return new Map();
    }
    const profiles = await this.profiles.find({
      where: { userId: In(senderIds) },
      select: { userId: true, firstName: true, lastName: true, slug: true },
    });
    return new Map(profiles.map((profile) => [profile.userId, profile]));
  }

  private unavailable(): NotFoundException {
    return new NotFoundException({
      statusCode: 404,
      message: 'There is no conversation to open for this report',
      code: CONVERSATION_CONTEXT_UNAVAILABLE_CODE,
    });
  }
}
