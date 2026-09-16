import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Res,
  UseGuards,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Response } from 'express';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Message } from '../messaging/entities/message.entity';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import {
  isMessageAttachmentStorageKey,
  primaryMessageAttachmentStorageKey,
} from '../messaging/message-evidence-hold';
import { StorageService } from '../storage/storage.service';
import { UserRole } from '../users/entities/user.entity';
import { Report, ReportSubjectType } from './entities/report.entity';
import { messageSnapshotFrom } from './report-evidence';

// `reports.subject_id` is a client-supplied `varchar`; `messages.id` is `uuid`.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The audit action one staff view of a reported message's file writes. The
 * frontend labels it through `admin:moderation.action.*` in
 * `queerpulse/src/features/admin/moderationActionLabels.ts`; an unmapped code
 * renders as the raw string, so the two must be added together.
 */
export const REPORT_MESSAGE_ATTACHMENT_VIEWED_AUDIT_ACTION =
  'report_message_attachment_viewed';

/**
 * PRD-361: the bytes of ONE reported message's attachment, for the moderator
 * reviewing that report and nobody else.
 *
 * Modelled on `ReportPhotoEvidenceController`, for the same reason. A
 * `message-image`/`message-document` key is served by `GET /files/<key>` only to
 * participants of a conversation holding an UN-deleted message that references
 * it, so a moderator reviewing an unsent image gets a 404 there, which is
 * exactly the case this evidence exists for. Widening `/files` for staff would
 * hand every moderator every private attachment on the platform. This route
 * takes a REPORT id, never a key, and resolves the key from that report's own
 * message row (tombstones included, since a deleted message keeps its bytes
 * under the evidence hold), falling back to the key in its `message-snapshot`.
 *
 * A 302 to a short-lived presigned GET, works as a plain `<img src>` or a
 * download link (the session is the httpOnly cookie), `VERSION_NEUTRAL` because
 * that address is built by hand from the API origin, and every refusal is the
 * same 404 so the route never distinguishes "no such report" from "no
 * attachment" from "the bytes are gone".
 */
@ApiTags('Admin — Moderation')
@ApiCookieAuth()
@Controller({ path: 'mod/report-message-attachment', version: VERSION_NEUTRAL })
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
export class ReportMessageAttachmentController {
  constructor(
    @InjectRepository(Report) private readonly reports: Repository<Report>,
    @InjectRepository(Message) private readonly messages: Repository<Message>,
    // Written directly rather than through `ModAuditService`: `ModerationModule`
    // imports `ReportsModule`, so injecting that service here would close a
    // module cycle. `MessagesService`'s staff-delete row (ENG-245) is written
    // the same way, against the same table and the same columns.
    @InjectRepository(ModAuditLog)
    private readonly auditLogs: Repository<ModAuditLog>,
    private readonly storage: StorageService,
  ) {}

  @Get(':reportId')
  @ApiOperation({
    summary:
      "Resolve one message report's attachment to a short-lived presigned download (302, writes an audit row)",
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to a short-lived presigned GET URL for the file.',
  })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
  @ApiNotFoundResponse({
    description:
      'No such report, not a message report, no platform-stored attachment, or the bytes have been purged.',
  })
  async serve(
    @Param('reportId', new ParseUUIDPipe()) reportId: string,
    @CurrentUser() user: CurrentUserData,
    @Res() response: Response,
  ): Promise<void> {
    const report = await this.reports.findOne({
      where: { id: reportId },
      select: { id: true, subjectType: true, subjectId: true, evidence: true },
    });
    if (!report || report.subjectType !== ReportSubjectType.Message) {
      throw new NotFoundException();
    }

    const message = UUID_RE.test(report.subjectId)
      ? await this.messages.findOne({
          where: { id: report.subjectId },
          withDeleted: true,
          select: { id: true, attachment: true },
        })
      : null;
    const storageKey =
      primaryMessageAttachmentStorageKey(message?.attachment) ??
      messageSnapshotFrom(report.evidence)?.attachment?.storageKey ??
      null;
    // Re-validated even from our own row: the key must parse as a MESSAGE
    // attachment key (the anchored pattern in `storage-key.ts` is the
    // path-traversal boundary), so this route can never become a general
    // object reader.
    if (!storageKey || !isMessageAttachmentStorageKey(storageKey)) {
      throw new NotFoundException();
    }

    // The sweep purges the bytes once the hold ends and no open report names
    // the message, so ask BEFORE minting a redirect to a missing key.
    try {
      await this.storage.headObject(storageKey);
    } catch {
      throw new NotFoundException();
    }

    // PRD-360's rule applied to the sharper case. The conversation-context
    // route records one row per opening because reading a private conversation
    // is a staff act worth a trail; opening an image somebody sent and then
    // unsent is at least as sensitive a look at private content, and this route
    // recorded nothing at all. Written only once the bytes are known to exist,
    // so a refusal logs no view, and before the redirect, so the record cannot
    // be lost to a response that never reaches the client.
    await this.auditLogs.save(
      this.auditLogs.create({
        reportId: report.id,
        actorId: user.userId,
        action: REPORT_MESSAGE_ATTACHMENT_VIEWED_AUDIT_ACTION,
        note: `Opened the file attached to reported message ${report.subjectId}`,
      }),
    );

    const downloadUrl = await this.storage.createPresignedDownload(storageKey);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.redirect(302, downloadUrl);
  }
}
