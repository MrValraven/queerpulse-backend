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
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { parseStorageKey } from '../storage/storage-key';
import { UPLOAD_KIND_SPECS } from '../storage/upload-kinds';
import { StorageService } from '../storage/storage.service';
import { Report, ReportSubjectType } from './entities/report.entity';
import { photoSnapshotFrom } from './report-evidence';

/**
 * The bytes of ONE reported gathering photo, for the moderator reviewing that
 * report and nobody else.
 *
 * ## Why this route exists rather than `GET /files/<key>`
 *
 * `gathering-photo` is a session-gated upload kind, and `FilesController` serves
 * a session-gated kind only to the member whose id is embedded in the key. That
 * is correct and must stay: it is what stops any logged-in member walking
 * `gathering-photos/<anyUserId>/<uuid>.jpg` and pulling identifiable photos of
 * people at events they never attended. It also means a moderator asking that
 * route for a reported photo gets a 404, so an `event_photo` report's evidence
 * would name a picture nobody reviewing it can see.
 *
 * Widening `/files` for staff would hand every moderator every gathering photo
 * on the platform. This route is the narrow version of the same grant: it takes
 * a REPORT id, never a storage key, and resolves the key from that report's own
 * `photo-snapshot` evidence. A moderator can therefore see exactly the photos
 * that have been reported to them, one report at a time, and nothing else. A
 * report's evidence never widens who can see a photograph.
 *
 * ## Shape
 *
 * A 302 to a short-lived presigned GET, exactly like `FilesController`: the
 * bytes come straight from the bucket and never pass through this service. It
 * works as a plain `<img src>` because the session is an httpOnly cookie, which
 * browsers attach to image requests. `VERSION_NEUTRAL` for the same reason that
 * route is: an `<img src>` is built by hand from the API origin and never passes
 * through the `/v1`-injecting API client.
 *
 * Deliberately NOT `@LockdownExempt()`. `PlatformLockdownGuard` already lets an
 * admin through unconditionally and a moderator through when
 * `lockdownAllowsModerators` is set, which is the same access the rest of the
 * moderation console has during a lockdown. An exemption here would be a wider
 * grant than the queue this image is rendered inside.
 */
@ApiTags('Admin — Moderation')
@ApiCookieAuth()
@Controller({ path: 'mod/report-photo-evidence', version: VERSION_NEUTRAL })
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
export class ReportPhotoEvidenceController {
  constructor(
    @InjectRepository(Report) private readonly reports: Repository<Report>,
    private readonly storage: StorageService,
  ) {}

  @Get(':reportId')
  @ApiOperation({
    summary:
      "Resolve one event_photo report's snapshotted photo to a short-lived presigned download (302)",
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to a short-lived presigned GET URL for the photo.',
  })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
  @ApiNotFoundResponse({
    description:
      'No such report, not a gathering-photo report, no snapshot on it, or the photo has since been deleted.',
  })
  async serve(
    @Param('reportId', new ParseUUIDPipe()) reportId: string,
    @Res() response: Response,
  ): Promise<void> {
    const report = await this.reports.findOne({
      where: { id: reportId },
      select: { id: true, subjectType: true, evidence: true },
    });
    // Every refusal below is the SAME 404, so the route never distinguishes
    // "no such report" from "that report is about something else" from "the
    // photo is gone". The frontend does not need them told apart: all four end
    // in the drawer saying the image is not available, and the report stays
    // actionable on the facts the snapshot carries.
    if (!report || report.subjectType !== ReportSubjectType.EventPhoto) {
      throw new NotFoundException();
    }

    const snapshot = photoSnapshotFrom(report.evidence);
    if (!snapshot) {
      throw new NotFoundException();
    }

    // The key came out of a `jsonb` column, so it is re-validated rather than
    // trusted: it must parse as a storage key at all (the anchored pattern in
    // `storage-key.ts` is the path-traversal boundary) and it must be a
    // GATHERING PHOTO. Without the second half, a future writer putting some
    // other kind's key into a `photo-snapshot` would turn a moderation route
    // into a general-purpose object reader.
    const kindSpec = parseStorageKey(snapshot.storageKey);
    if (kindSpec !== UPLOAD_KIND_SPECS['gathering-photo']) {
      throw new NotFoundException();
    }

    // Is the object still there? The uploader can remove the photo, and
    // `EventPhotosService.remove` deletes the stored object along with the row,
    // so a report can outlive its image. Asked BEFORE minting a redirect,
    // because a presigned URL to a deleted key is a broken image in the drawer
    // and a moderator cannot tell that apart from an outage. One `HeadObject`,
    // on a route a human hits once per report.
    try {
      await this.storage.headObject(snapshot.storageKey);
    } catch {
      throw new NotFoundException();
    }

    const downloadUrl = await this.storage.createPresignedDownload(
      snapshot.storageKey,
    );
    // `no-store`, matching how `FilesController` treats every session-gated
    // kind: this response is specific to who is asking, and Railway's edge
    // cache once served authenticated responses to the wrong users.
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.redirect(302, downloadUrl);
  }
}
