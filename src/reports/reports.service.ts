import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { HousingListing } from '../housing-listings/entities/housing-listing.entity';
import { Message } from '../messaging/entities/message.entity';
import {
  Report,
  ReportStatus,
  ReportSubjectType,
} from './entities/report.entity';
import {
  REPORT_DAILY_CAP_MESSAGE,
  REPORT_DAILY_LIMIT,
  REPORT_DAILY_WINDOW_MS,
  REPORT_FLOOD_CAP_CODE,
  REPORT_PER_SUBJECT_CAP_MESSAGE,
  REPORT_PER_SUBJECT_LIMIT,
  REPORT_PER_SUBJECT_WINDOW_MS,
  type ReportFloodCap,
} from './report-flood-limits';
import { MetricsService } from '../metrics/metrics.service';
import { reasonsFor, ReasonCode, ReasonOption } from './reason-catalogue';
import { deriveSeverity, slaDueAtFor } from './report-severity';
import { ReportDTO, toReportDTO } from './report-response';
import { REPORT_CREATED, ReportCreatedEvent } from './report.events';

export interface ReportEvidenceInput {
  type: 'url' | 'screenshot';
  value?: string;
  uploadId?: string;
}

// How much of a caller-supplied `subjectId` reaches the moderation log line.
// Every real subject id is far shorter (a uuid is 36, a slug shorter still),
// so this only ever truncates something padded out toward the DTO's 200-char
// ceiling to push the rest of the line out of view.
const MAX_LOGGED_SUBJECT_ID_LENGTH = 64;

/**
 * Makes a caller-supplied string safe to interpolate into a `key=value` log
 * line: collapses every character outside a conservative allowlist to `_`, then
 * truncates.
 *
 * An ALLOWLIST rather than a denylist of newlines, because the shapes that
 * corrupt a log line are open-ended (CR, LF, NEL, line/paragraph separators,
 * a bare `=`, quotes, ANSI escapes) while the shapes a legitimate subject id
 * takes are not: uuids, slugs, and content ids all live comfortably inside
 * word characters plus `.`, `:`, `@`, `/` and `-`. Enumerating what is safe is
 * the side of this worth being exhaustive about.
 *
 * See `ReportsService.recordRefusal` for why this is applied even though the
 * current log transport already escapes its values.
 */
function sanitizeForLogLine(value: string): string {
  const collapsed = value.replace(/[^\w.:@/-]+/g, '_');
  return collapsed.length > MAX_LOGGED_SUBJECT_ID_LENGTH
    ? `${collapsed.slice(0, MAX_LOGGED_SUBJECT_ID_LENGTH)}_truncated`
    : collapsed;
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

/**
 * Filing and reading member reports.
 *
 * Three independent guards sit on `create`, in this order:
 *
 * 1. The 60-second burst `@Throttle` on `ReportsController.create`, which stops
 *    a script hammering the endpoint.
 * 2. The open-report dedupe below, which makes a double-submit idempotent and
 *    keeps identical rows off the moderation queue.
 * 3. The rolling per-reporter and per-subject caps in `report-flood-limits.ts`,
 *    which bound the SUSTAINED flood the first two cannot see.
 *
 * That file's doc comment is the full argument for why each layer exists and
 * why none of them subsumes another. Read it before changing any of the three.
 */
@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

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
    // Counts flood-cap refusals, which write no report row and are therefore
    // invisible to every row-counting moderation surface. `MetricsModule` is
    // `@Global` and exports this, so `ReportsModule` needs no import.
    private readonly metrics: MetricsService,
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

    // Rolling flood caps (TS-05). Checked HERE, after the dedupe fast-path has
    // already returned, so a network retry or a double-tapped submit button
    // never spends a slot and never gets refused: that request is answered
    // idempotently above and never reaches this point. Only a genuinely new
    // report is counted against the caps.
    await this.assertReportingWindowIsClear(reporterId, input);

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

  /**
   * The rolling flood caps: at most `REPORT_DAILY_LIMIT` reports across all
   * subjects in `REPORT_DAILY_WINDOW_MS`, and at most
   * `REPORT_PER_SUBJECT_LIMIT` against one subject in
   * `REPORT_PER_SUBJECT_WINDOW_MS`. Every number lives in
   * `report-flood-limits.ts`; nothing is hard-coded here.
   *
   * Both counts ignore `status` on purpose, so a moderator closing a case does
   * not hand the allowance back. See that file for the rest of the argument.
   *
   * ## Counted on the subject, never on the subject's owner
   *
   * The per-subject cap keys on (`subjectType`, `subjectId`) exactly as filed.
   * `subjectId` is a `varchar` addressed differently per domain, so mapping a
   * historical row back to a person means a per-domain lookup for every row in
   * the window, on a path that runs on every single filing. The residual gap is
   * real and deliberate: a reporter can still spread filings across many
   * distinct subjects belonging to the same target, for instance a message id
   * per message. The daily cap is what bounds that, and the refusal log below
   * is what puts a moderator onto it.
   *
   * ## No row lock
   *
   * Unlike `VouchService`'s daily cap this does not take a pessimistic lock
   * before counting, matching `CommunityOwnerReviewService`. Two concurrent
   * filings can both read a count one under the cap and both insert. Letting a
   * single extra report through costs nothing here: this is a flood ceiling,
   * where the difference between 30 and 31 is immaterial, and the burst
   * `@Throttle` already bounds how much concurrency is reachable. The vouch cap
   * locks because a vouch is a trust signal whose exact count is load-bearing.
   */
  private async assertReportingWindowIsClear(
    reporterId: string,
    input: CreateReportInput,
  ): Promise<void> {
    const now = Date.now();

    // Served by `IDX_reports_reporter_created_at` on (reporter_id, created_at
    // DESC) as an index range scan. See
    // `1795710000000-AddReportsReporterCreatedAtIndex`.
    const dailyWindowStartedAt = new Date(now - REPORT_DAILY_WINDOW_MS);
    const filedInDailyWindow = await this.reports.count({
      where: {
        reporterId,
        createdAt: MoreThanOrEqual(dailyWindowStartedAt),
      },
    });
    if (filedInDailyWindow >= REPORT_DAILY_LIMIT) {
      this.recordRefusal({
        reporterId,
        cap: 'daily',
        limit: REPORT_DAILY_LIMIT,
        windowMs: REPORT_DAILY_WINDOW_MS,
        filedInWindow: filedInDailyWindow,
        input,
      });
      // OBJECT body, never a bare string, so the client can tell this refusal
      // apart from the OTHER 429 this same route can answer with: the
      // `@nestjs/throttler` burst refusal, whose body is a string and whose
      // `message` is a framework exception string a member must never be shown.
      // Nest ships a string-thrown body with no `code`, so the presence of
      // `code` IS the discriminator. Matching on message text instead would
      // break silently the day the throttler reworded its default, and the
      // failure mode is raw framework prose on a member's screen. See
      // `report-flood-limits.ts` and `common/all-exceptions.filter.ts`.
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          code: REPORT_FLOOD_CAP_CODE,
          // Additive detail, safe to ignore: `code` alone is the contract.
          cap: 'daily',
          message: REPORT_DAILY_CAP_MESSAGE,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Same index, one range wider. The daily cap above is what keeps this
    // second count cheap without a subject-bearing index of its own: it bounds
    // the reporter's rows inside the 7-day window at roughly 7 x
    // `REPORT_DAILY_LIMIT`, so the planner filters the subject columns over a
    // couple of hundred tuples at the very worst.
    const subjectWindowStartedAt = new Date(now - REPORT_PER_SUBJECT_WINDOW_MS);
    const filedAgainstSubject = await this.reports.count({
      where: {
        reporterId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        createdAt: MoreThanOrEqual(subjectWindowStartedAt),
      },
    });
    if (filedAgainstSubject >= REPORT_PER_SUBJECT_LIMIT) {
      this.recordRefusal({
        reporterId,
        cap: 'subject',
        limit: REPORT_PER_SUBJECT_LIMIT,
        windowMs: REPORT_PER_SUBJECT_WINDOW_MS,
        filedInWindow: filedAgainstSubject,
        input,
      });
      // Same object body and the same single `code` as the daily cap above:
      // the client's question is only ever "does this 429 carry copy worth
      // showing?", and the member-facing difference is already in `message`.
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          code: REPORT_FLOOD_CAP_CODE,
          cap: 'subject',
          message: REPORT_PER_SUBJECT_CAP_MESSAGE,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * A refused filing is a moderation signal, so it is never silent.
   *
   * A member who reaches either cap is either being harassed at scale, and is
   * frantically reporting a brigade, or is themselves using the report form as
   * the weapon. Both want a human looking, and neither is visible anywhere else
   * because a refused report writes no row.
   *
   * Recorded TWO ways, because they serve different readers.
   *
   * A Prometheus counter (`moderation_report_flood_refusals_total`, labelled
   * only by `cap`) is what a moderation surface can actually see. This matters
   * more than it looks: a refusal writes no report row, and every existing view
   * of moderation load counts rows, so once these caps start biting a concerted
   * flood would otherwise become LESS visible than it was before they existed.
   * The filings past the ceiling stop reaching the queue and its depth stops
   * rising. The counter is what keeps the pressure on a dashboard. No
   * per-reporter label, ever: unbounded cardinality, and a scrape surface is
   * the wrong place for a member's identity.
   *
   * A single greppable log line carries the detail a human needs once the
   * counter has pointed them at a window: which member, which subject, which
   * reason. It goes through the repo's standard `@nestjs/common` `Logger`,
   * which `main.ts` points at `nestjs-pino`, so it lands in the same structured
   * stream as every other server log, with `report-flood-cap` as the stable
   * grep handle. No email, since QueerPulse sends none.
   *
   * `reasonCode` and the subject are included because they are what makes the
   * line actionable. The report DETAIL text is deliberately left out: it is the
   * reporter's own words about another member, and a log stream is the wrong
   * home for that.
   */
  private recordRefusal(refusal: {
    reporterId: string;
    cap: ReportFloodCap;
    limit: number;
    windowMs: number;
    filedInWindow: number;
    input: CreateReportInput;
  }): void {
    this.metrics.incrementReportFloodRefusal(refusal.cap);

    const windowHours = Math.round(refusal.windowMs / (60 * 60 * 1000));
    // `subjectId` is the ONLY caller-controlled value on this line. Its DTO
    // rule is `@IsString() @MinLength(1) @MaxLength(200)` with no charset
    // restriction, so newlines and `key=value` pairs pass validation, and a
    // reporter needs only four requests to reach here with a crafted one:
    // three against the same subject, then a fourth to trip the cap. Sanitised
    // rather than trusted, so a forged `reporterId=` or a second fake line can
    // never appear in the moderation log. Today `nestjs-pino` JSON-escapes the
    // value anyway, which makes this latent rather than live. Keep it: that
    // safety comes from the TRANSPORT, and this line should stay correct if the
    // transport is ever swapped. Every other value here is server-owned
    // (`reporterId` is a uuid off the JWT; `subjectType` and `reasonCode` are
    // `@IsIn` enum vocabularies), so they need no such treatment.
    const subjectId = sanitizeForLogLine(refusal.input.subjectId);
    this.logger.warn(
      `report-flood-cap refused a filing. ` +
        `cap=${refusal.cap} limit=${refusal.limit} windowHours=${windowHours} ` +
        `filedInWindow=${refusal.filedInWindow} reporterId=${refusal.reporterId} ` +
        `subjectType=${refusal.input.subjectType} subjectId=${subjectId} ` +
        `reasonCode=${refusal.input.reasonCode}`,
    );
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

  // The reporter's own filed reports, newest first — backs `GET /reports/mine`
  // so a member can check on something they reported. Capped at 50: this is a
  // self-service status list, not a full moderation history export.
  async listMine(reporterId: string): Promise<Report[]> {
    return this.reports.find({
      where: { reporterId },
      order: { createdAt: 'DESC' },
      take: 50,
    });
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
