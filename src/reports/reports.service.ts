import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { HousingListing } from '../housing-listings/entities/housing-listing.entity';
import { Message } from '../messaging/entities/message.entity';
import {
  Report,
  ReportStatus,
  ReportSubjectType,
} from './entities/report.entity';
import { reasonsFor, ReasonCode, ReasonOption } from './reason-catalogue';
import { deriveSeverity, slaDueAtFor } from './report-severity';
import { ReportDTO, toReportDTO } from './report-response';
import { REPORT_CREATED, ReportCreatedEvent } from './report.events';

export interface ReportEvidenceInput {
  type: 'url' | 'screenshot';
  value?: string;
  uploadId?: string;
}

export interface CreateReportInput {
  subjectType: ReportSubjectType;
  subjectId: string;
  reasonCode: ReasonCode;
  detail?: string;
  anonymous?: boolean;
  contactEmail?: string;
  evidence?: ReportEvidenceInput[];
}

@Injectable()
export class ReportsService {
  constructor(
    @InjectRepository(Report) private readonly reports: Repository<Report>,
    // Read-only lookup for the message self-report guard below. Registered
    // directly in `ReportsModule` (not via `MessagingModule`, which would
    // create a cycle through `SocialModule` -> `ReportsModule`) — TypeORM
    // permits the same entity's repository being registered in more than one
    // module (see `AccountModule`'s identical cross-module `Message` reuse).
    @InjectRepository(Message) private readonly messages: Repository<Message>,
    // Read-only lookup so a housing-listing report can snapshot the listing's
    // key fields into `evidence` at filing time (P0.9). Registered directly in
    // `ReportsModule` (same cross-module `forFeature` pattern as `Message`).
    @InjectRepository(HousingListing)
    private readonly housing: Repository<HousingListing>,
    // Fire-and-forget domain event on a genuinely new report — a community
    // auto-freeze listener reacts to it. `EventEmitter2` is globally available
    // (`EventEmitterModule.forRoot()` in the root module), so no module change
    // is needed here.
    private readonly events: EventEmitter2,
  ) {}

  async create(
    reporterId: string,
    input: CreateReportInput,
  ): Promise<ReportDTO> {
    // A member can't report their own message — mirrors the DTO's `canReport`
    // flag (`!isDeleted && !isAuthor` in `MessagingCoreService.toMessageResponses`),
    // which is only a UI convenience unless the server enforces the same rule.
    // Scoped to the `message` subject type only: other subject types (member,
    // post, reply, …) have no equivalent server-computed "is this mine" flag
    // today, so there's no matching gap to close for them here. Kept (not
    // re-fetched below) so its body can be snapshotted into `evidence` — see
    // `buildEvidence`.
    let reportedMessage: Message | null = null;
    if (input.subjectType === ReportSubjectType.Message) {
      reportedMessage = await this.messages.findOne({
        where: { id: input.subjectId },
        // A soft-deleted message still has a real author; withDeleted so a
        // deleted-but-still-yours message can't be self-reported either.
        withDeleted: true,
      });
      if (reportedMessage && reportedMessage.senderId === reporterId) {
        throw new ForbiddenException('You cannot report your own message');
      }
    }

    // Housing-listing report (P0.9): snapshot the listing's key fields NOW, so a
    // moderator reviewing later sees exactly what was reported even if the owner
    // edits or the listing is taken down in the meantime. Server-authoritative
    // (looked up here, never trusted from the client) and keyed by the slug the
    // report carries as `subjectId`.
    let reportedHousing: HousingListing | null = null;
    if (input.subjectType === ReportSubjectType.Housing) {
      reportedHousing = await this.housing.findOne({
        where: { slug: input.subjectId },
      });
    }

    // De-duplicate: one open report per (reporter, subject). A member
    // double-submitting — or re-reporting a subject already in the queue — gets
    // the existing report back rather than piling identical rows on the mods'
    // desk. The `findOne` fast-paths the common case; the partial unique index
    // `UQ_reports_open_reporter_subject` (WHERE status = 'open') is what
    // actually closes the check-then-insert race — two concurrent identical
    // filings can both miss the `findOne`, and the loser of the insert race
    // then re-reads and returns the winner's row (below). (Resolved/escalated
    // reports don't block a fresh filing: a recurrence after a resolution is
    // worth surfacing again, hence the partial `WHERE status = 'open'`.)
    const existing = await this.findOpenReport(reporterId, input);
    if (existing) {
      return toReportDTO(existing);
    }

    const severity = deriveSeverity(input.reasonCode);
    const now = new Date();

    try {
      const saved = await this.reports.save(
        this.reports.create({
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          reasonCode: input.reasonCode,
          detail: input.detail ?? null,
          anonymous: input.anonymous ?? false,
          contactEmail: input.contactEmail ?? null,
          evidence: this.buildEvidence(
            input.evidence,
            reportedMessage,
            reportedHousing,
          ),
          severity,
          slaDueAt: slaDueAtFor(severity, now),
          status: ReportStatus.Open,
          reporterId,
        }),
      );
      // Only a genuinely new report emits — the dedupe fast-path above returns
      // without reaching here. Best-effort by contract (see ReportCreatedEvent);
      // a listener throwing must not fail this filing.
      this.events.emit(REPORT_CREATED, {
        reportId: saved.id,
        subjectType: saved.subjectType,
        subjectId: saved.subjectId,
        severity: saved.severity,
        reasonCode: saved.reasonCode,
      } satisfies ReportCreatedEvent);
      return toReportDTO(saved);
    } catch (error) {
      // Lost the insert race against a concurrent identical filing — the
      // partial unique index rejected the duplicate open report. Converge on
      // the same idempotent outcome as the `findOne` fast-path: return the
      // report that won.
      if (isUniqueViolation(error, 'UQ_reports_open_reporter_subject')) {
        const winner = await this.findOpenReport(reporterId, input);
        if (winner) {
          return toReportDTO(winner);
        }
      }
      throw error;
    }
  }

  private findOpenReport(
    reporterId: string,
    input: CreateReportInput,
  ): Promise<Report | null> {
    return this.reports.findOne({
      where: {
        reporterId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        // Dedupe collapses only SAME-reason open reports by the same reporter
        // on the same subject. Two DISTINCT reasonCodes on one subject (e.g. a
        // `listing_dispute` then a high-severity abuse report on the same
        // listing) are genuinely different reports and must both reach the
        // queue — keyed here (and in the partial unique index) on reasonCode so
        // a distinct/higher-severity filing isn't silently dropped.
        reasonCode: input.reasonCode,
        status: ReportStatus.Open,
      },
    });
  }

  // Server-owned reason taxonomy — always `other` plus whatever's relevant
  // to the subject type (see `reason-catalogue.ts`).
  reasonsFor(subjectType: ReportSubjectType): ReasonOption[] {
    return reasonsFor(subjectType);
  }

  /**
   * Merges the reporter's own evidence with a server-authoritative snapshot
   * of the reported message's content, when the subject is a message
   * (messaging P0.7 safety slice — "preserve the reported message context as
   * evidence"). Necessary because `Message.body` has no version history:
   * `MessagingService.editMessage` overwrites it in place, so a message that
   * gets edited (within its 15-minute author-only window) or later
   * soft-deleted after being reported would otherwise leave moderators
   * looking at content that no longer matches what was actually reported.
   * Captured here — not trusted from the client — so it can't be spoofed or
   * omitted by a caller that forgot to attach it. Stored in the same
   * `evidence` jsonb array as client-supplied entries (`{type:'url'|
   * 'screenshot',…}`); this entry uses its own `type: 'message-snapshot'`
   * discriminant, which existing evidence consumers should treat as opaque
   * unless they specifically render it.
   */
  private buildEvidence(
    clientEvidence: CreateReportInput['evidence'],
    reportedMessage: Message | null,
    reportedHousing: HousingListing | null,
  ): unknown[] | null {
    const evidence: unknown[] = clientEvidence ? [...clientEvidence] : [];
    if (reportedMessage) {
      evidence.push({
        type: 'message-snapshot',
        messageId: reportedMessage.id,
        body: reportedMessage.body,
        senderId: reportedMessage.senderId,
        createdAt: reportedMessage.createdAt.toISOString(),
        editedAt: reportedMessage.editedAt?.toISOString() ?? null,
        deletedAtTimeOfReport: reportedMessage.deletedAt != null,
      });
    }
    // Housing-listing snapshot (P0.9): the key fields a moderator needs to judge
    // a reported home — captured at filing time so a later edit/takedown can't
    // rewrite what was reported. `listerId` (owner) not the lister's name: this
    // is an internal moderation record, kept minimal. Uses its own
    // `type: 'housing-snapshot'` discriminant, opaque to other evidence readers.
    if (reportedHousing) {
      evidence.push({
        type: 'housing-snapshot',
        ref: reportedHousing.ref,
        slug: reportedHousing.slug,
        title: reportedHousing.title,
        blurb: reportedHousing.blurb,
        rentEuros: reportedHousing.rentEuros,
        city: reportedHousing.city,
        area: reportedHousing.area,
        listerId: reportedHousing.ownerId,
        listedAt: reportedHousing.createdAt.toISOString(),
        snapshotAt: new Date().toISOString(),
      });
    }
    return evidence.length ? evidence : null;
  }
}
