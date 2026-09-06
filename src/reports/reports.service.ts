import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomBytes } from 'crypto';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { EventPhoto } from '../events/entities/event-photo.entity';
import { HousingListing } from '../housing-listings/entities/housing-listing.entity';
import { Message } from '../messaging/entities/message.entity';
import {
  Report,
  ReportSeverity,
  ReportStatus,
  ReportSubjectType,
} from './entities/report.entity';
import { deriveAnonymousReporterKey } from './anonymous-reporter-key';
import {
  REPORT_ANONYMOUS_DAILY_CAP_MESSAGE,
  REPORT_ANONYMOUS_DAILY_EMERGENCY_ALLOWANCE,
  REPORT_ANONYMOUS_DAILY_EMERGENCY_ALLOWANCE_MESSAGE,
  REPORT_ANONYMOUS_DAILY_EMERGENCY_CEILING,
  REPORT_ANONYMOUS_DAILY_LIMIT,
  REPORT_ANONYMOUS_DAILY_WINDOW_MS,
  REPORT_ANONYMOUS_PER_SUBJECT_CAP_MESSAGE,
  REPORT_ANONYMOUS_PER_SUBJECT_LIMIT,
  REPORT_ANONYMOUS_PER_SUBJECT_WINDOW_MS,
  REPORT_DAILY_CAP_MESSAGE,
  REPORT_DAILY_EMERGENCY_ALLOWANCE,
  REPORT_DAILY_EMERGENCY_ALLOWANCE_MESSAGE,
  REPORT_DAILY_EMERGENCY_CEILING,
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
import { PHOTO_SNAPSHOT_TYPE } from './report-evidence';

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

// A `subjectId` is a `varchar` the reporter's client supplies, validated only
// as a 1-200 character string (`CreateReportDto`). The subjects addressed by a
// uuid therefore need this before their id reaches a `uuid` column, or an
// arbitrary string turns a filing into a Postgres `22P02` and a 500. Declared
// locally, exactly as `AdminCommunitiesService` and `CommunityMembershipService`
// each declare their own: the alternative is a shared utility nothing else
// wants, or reaching into another module's internals for one regex.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 *
 * All three of those describe a SIGNED-IN filing. `POST /reports` is public
 * (PRD-280), and on a signed-out filing layer 2 is deliberately skipped and
 * layer 3 is replaced: `assertAnonymousReportingWindowIsClear` runs separate,
 * tighter caps keyed on a peppered digest of the caller's network address. The
 * signed-in path is byte-for-byte what it was.
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
    // Read-only lookup so an `event_photo` report can snapshot the photo's
    // facts into `evidence` at filing time. Registered directly in
    // `ReportsModule` (same cross-module `forFeature` pattern as `Message` and
    // `HousingListing` above) rather than importing `EventsModule`, which would
    // pull a whole feature module in for one `findOne`.
    @InjectRepository(EventPhoto)
    private readonly eventPhotos: Repository<EventPhoto>,
    // Fire-and-forget domain event on a genuinely new report — a community
    // auto-freeze listener reacts to it. `EventEmitter2` is globally available
    // (`EventEmitterModule.forRoot()` in the root module), so no module change
    // is needed here.
    private readonly events: EventEmitter2,
    // Counts flood-cap refusals, which write no report row and are therefore
    // invisible to every row-counting moderation surface. `MetricsModule` is
    // `@Global` and exports this, so `ReportsModule` needs no import.
    private readonly metrics: MetricsService,
    // Holds the pepper the anonymous flood-cap key is derived under
    // (`reports.config.ts`, registered via `ConfigModule.forFeature` in
    // `ReportsModule`). `ConfigModule` is global, so nothing else is needed.
    private readonly config: ConfigService,
  ) {}

  /**
   * The fallback pepper for the anonymous flood-cap key, generated ONCE per
   * process. Used only when `REPORT_ANONYMOUS_FLOOD_PEPPER` is unset.
   *
   * Deliberately random rather than a constant. A hard-coded default would be
   * in the repository, and a pepper in the repository is not a pepper: the
   * digests on the `reports` table would be reversible by anyone who could read
   * both. The cost of randomness is that the anonymous caps reset when the
   * process restarts, which is the same durability the burst `@Throttle` has,
   * and `reports.config.ts` says so.
   */
  private readonly fallbackAnonymousFloodPepper =
    randomBytes(32).toString('hex');

  private hasWarnedAboutMissingAnonymousFloodPepper = false;

  /**
   * The configured pepper, or the per-process fallback. Warns ONCE per process
   * when it falls back, so an operator sees it without a line per filing.
   */
  private anonymousFloodPepper(): string {
    const configured = this.config.get<string>('reports.anonymousFloodPepper');
    if (configured) {
      return configured;
    }
    if (!this.hasWarnedAboutMissingAnonymousFloodPepper) {
      this.hasWarnedAboutMissingAnonymousFloodPepper = true;
      this.logger.warn(
        'REPORT_ANONYMOUS_FLOOD_PEPPER is not set. The anonymous report flood caps are running under a per-process pepper, so they reset on every restart. Set it in production.',
      );
    }
    return this.fallbackAnonymousFloodPepper;
  }

  /**
   * File a report. `reporterId` is NULL for a signed-out filing, which
   * `POST /reports` now accepts (PRD-280).
   *
   * `clientIp` is the raw client address the controller read off the request
   * (`@Ip()`, resolved through `trust proxy` in `main.ts`). It is used for ONE
   * thing and never stored: deriving the anonymous flood-cap key. It is
   * ignored entirely on a signed-in filing, whose caps key on the account.
   * Optional and defaulting to null so the server-side callers that file
   * through this pipeline (`ListingsService`'s dispute and owner-notify tasks)
   * need no change: they always carry a real `reporterId` and no request.
   */
  async create(
    reporterId: string | null,
    input: CreateReportInput,
    clientIp: string | null = null,
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
      // `reporterId !== null` is spelled out rather than left to the strict
      // comparison below doing the right thing by accident: a signed-out caller
      // has no messages to self-report, and an anonymous filing must never be
      // refused because some column somewhere went nullable.
      if (
        reporterId !== null &&
        reportedMessage &&
        reportedMessage.senderId === reporterId
      ) {
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

    // Gathering-photo report: snapshot the photo's facts NOW. Sharper than the
    // two snapshots above, because this subject's whole content is an image and
    // the uploader can delete it — `EventPhotosService.remove` drops the row,
    // the crop AND the stored object. See `PhotoSnapshotEvidence` for why the
    // BYTES are still held by reference and no second copy is kept.
    //
    // Guarded by `UUID_RE`: `subjectId` is a client string and `event_photos.id`
    // is a `uuid` column, so an arbitrary value would 500 the filing rather than
    // simply failing to match. A non-uuid could never have named a photo anyway,
    // so skipping the lookup is behaviour-preserving and the report still files.
    let reportedEventPhoto: EventPhoto | null = null;
    if (
      input.subjectType === ReportSubjectType.EventPhoto &&
      UUID_RE.test(input.subjectId)
    ) {
      reportedEventPhoto = await this.eventPhotos.findOne({
        where: { id: input.subjectId },
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
    //
    // SIGNED-IN ONLY, and the guard is the point rather than an optimisation.
    // There is no anonymous equivalent of "the caller's existing open report",
    // because there is no caller to own one. Matching on `reporterId IS NULL`
    // would collapse across PEOPLE: the first stranger to report a subject for
    // a reason would own that row, and every later signed-out reporter naming
    // the same subject and reason would have their filing thrown away and be
    // handed somebody else's report back as if it were theirs. That is a
    // silent loss of a safety report and a leak of another person's report id
    // and status in one move. The database agrees by accident and then by
    // design: `UQ_reports_open_reporter_subject` is over `reporter_id`, and
    // Postgres treats NULLs as distinct in a unique index, so two anonymous
    // rows never collide there either.
    //
    // The price is that the anonymous path has no idempotency: a double-tapped
    // submit or a retry after a dropped connection writes two rows.
    // `REPORT_ANONYMOUS_PER_SUBJECT_LIMIT` is sized to absorb exactly that.
    const existing =
      reporterId === null ? null : await this.findOpenReport(reporterId, input);
    if (existing) {
      return toReportDTO(existing);
    }

    // Derived BEFORE the flood caps run, because the caps need it: an
    // Emergency-band filing (`outing` / `doxxing`, per `EMERGENCY_REASONS` in
    // `report-severity.ts`) is exempt from the per-subject cap and carries a
    // bounded allowance above the daily one. Deriving it here keeps ONE
    // definition of the emergency band. Re-listing the two codes beside either
    // cap check would be a second hand-maintained copy of the same list, which
    // is exactly the drift that let this bug exist.
    const severity = deriveSeverity(input.reasonCode);

    // Rolling flood caps (TS-05). Checked HERE, after the dedupe fast-path has
    // already returned, so a network retry or a double-tapped submit button
    // never spends a slot and never gets refused: that request is answered
    // idempotently above and never reaches this point. Only a genuinely new
    // report is counted against the caps.
    //
    // Two sets of caps, one per path, and a filing is only ever subject to
    // one. A signed-in filing is counted per member off `reporterId`, exactly
    // as it always was; nothing about that path changed when the route became
    // public. A signed-out filing is counted per anonymous key, under the
    // separate and tighter numbers in `report-flood-limits.ts`.
    const anonymousReporterKey =
      reporterId === null
        ? deriveAnonymousReporterKey(clientIp, this.anonymousFloodPepper())
        : null;
    if (reporterId === null) {
      await this.assertAnonymousReportingWindowIsClear(
        anonymousReporterKey,
        input,
        severity,
      );
    } else {
      await this.assertReportingWindowIsClear(reporterId, input, severity);
    }

    const now = new Date();

    try {
      const saved = await this.reports.save(
        this.reports.create({
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          reasonCode: input.reasonCode,
          detail: input.detail ?? null,
          anonymous: input.anonymous ?? false,
          // SERVER-SIDE RULE, never the client's to decide (PRD-281): a
          // contact address is stored only when there is no account behind the
          // report. A signed-in member is already reachable through the
          // notification bell and can read their own report's status on
          // `GET /reports/mine`, so an off-platform address filed beside their
          // account buys nothing and leaves a second copy of their personal
          // data sitting on a moderation row. A signed-in filing that carries
          // one has it DROPPED rather than refused: the report is the thing
          // that matters, and refusing it over a field the reporter should not
          // have been shown would be the wrong trade. The frontend hides the
          // field for signed-in members; this is what makes that true rather
          // than merely displayed. Nothing sends to the stored address either
          // way, here or anywhere: QueerPulse delivers no email, and it is
          // kept so a human on the safety team can choose to reach out by hand.
          contactEmail:
            reporterId === null ? (input.contactEmail ?? null) : null,
          anonymousReporterKey,
          evidence: this.buildEvidence(
            input.evidence,
            reportedMessage,
            reportedHousing,
            reportedEventPhoto,
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
      //
      // Signed-in only, for the same reason the fast-path above is. The index
      // is over `reporter_id` and Postgres treats NULLs as distinct, so an
      // anonymous insert cannot raise this violation in the first place; the
      // `reporterId !== null` test is here so that if some future index ever
      // did make it possible, the recovery would not silently hand one
      // stranger another stranger's report.
      if (
        reporterId !== null &&
        isUniqueViolation(error, 'UQ_reports_open_reporter_subject')
      ) {
        const winner = await this.findOpenReport(reporterId, input);
        if (winner) {
          return toReportDTO(winner);
        }
      }
      throw error;
    }
  }

  /**
   * The rolling flood caps for a SIGNED-IN filing, unchanged by PRD-280: a
   * signed-out one is counted by `assertAnonymousReportingWindowIsClear`
   * instead and never reaches here.
   *
   * At most `REPORT_DAILY_LIMIT` reports across all
   * subjects in `REPORT_DAILY_WINDOW_MS`, and at most
   * `REPORT_PER_SUBJECT_LIMIT` against one subject in
   * `REPORT_PER_SUBJECT_WINDOW_MS`. Every number lives in
   * `report-flood-limits.ts`; nothing is hard-coded here.
   *
   * Both counts ignore `status` on purpose, so a moderator closing a case does
   * not hand the allowance back. See that file for the rest of the argument.
   *
   * ## The per-subject cap yields to an Emergency filing
   *
   * A report whose derived severity is `Emergency` (`outing` / `doxxing`) is
   * never refused by the per-subject cap. The whole promise of that band is a
   * one-hour response, and a cap that answers "you have already reported this
   * three times" to somebody being outed refuses the one report the platform
   * commits hardest to reading. The shapes the per-subject cap exists to catch
   * are re-filing after each closure and piling on a target, and neither is
   * worth buying at the price of silencing an active outing.
   *
   * The count still RUNS for an Emergency filing, so a member who would have
   * been refused is logged as a bypass rather than passing invisibly. A
   * reporter reaching for `outing` a fourth time against one subject is either
   * genuinely in danger or is using the emergency band to walk around the cap,
   * and the log line is what puts a moderator onto either one.
   *
   * ## The daily cap grants an allowance, never an exemption
   *
   * The DAILY cap is the ceiling on a single account flooding the whole
   * platform, and exempting a reason code from it would hand any account an
   * unbounded allowance for the asking, with the emergency band as the cheapest
   * way to take it. So the emergency band buys room above the cap rather than
   * freedom from it: once a reporter is at `REPORT_DAILY_LIMIT`, an Emergency
   * filing is still accepted up to `REPORT_DAILY_EMERGENCY_CEILING`, and past
   * that even an Emergency filing is refused. A genuine emergency at report
   * thirty-one goes through. Nobody files unboundedly by typing `outing` every
   * time, because the ceiling is absolute and counted per reporter per 24
   * hours, exactly like the cap it sits above.
   *
   * Both branches are written down. Spending the allowance logs a bypass under
   * `report-flood-cap-emergency-bypass` with `cap=daily`, which is what tells
   * it apart from the per-subject bypass above. Exhausting the allowance logs
   * `report-flood-cap-emergency-allowance-exhausted`, and that is the loudest
   * line this file can write: the reporter is either somebody a very bad day
   * has run past every ceiling the product has, or somebody who has now spent
   * thirty-five filings in a day. `report-flood-limits.ts` carries the argument
   * for the size of the allowance.
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
    severity: ReportSeverity,
  ): Promise<void> {
    const now = Date.now();
    // Read off the severity the caller already derived, so the emergency band
    // has exactly ONE definition (`EMERGENCY_REASONS` in `report-severity.ts`)
    // and this file never holds a copy of it that can drift.
    const isEmergencyReport = severity === ReportSeverity.Emergency;

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
      // The bounded allowance above the cap. `isEmergencyReport` is read off
      // the severity `create` already derived, so the emergency band still has
      // exactly one definition, and a third code added to `EMERGENCY_REASONS`
      // gets this allowance without a line changing here. The comparison is
      // against the same `filedInDailyWindow` count the cap used, so the
      // allowance is counted per reporter over the same rolling 24 hours and
      // costs no second query on the filing path.
      const hasEmergencyAllowanceLeft =
        isEmergencyReport &&
        filedInDailyWindow < REPORT_DAILY_EMERGENCY_CEILING;

      if (!hasEmergencyAllowanceLeft) {
        if (isEmergencyReport) {
          this.recordEmergencyAllowanceExhausted({
            reporterId,
            limit: REPORT_DAILY_LIMIT,
            allowance: REPORT_DAILY_EMERGENCY_ALLOWANCE,
            windowMs: REPORT_DAILY_WINDOW_MS,
            filedInWindow: filedInDailyWindow,
            input,
          });
        } else {
          this.recordRefusal({
            reporterId,
            cap: 'daily',
            limit: REPORT_DAILY_LIMIT,
            windowMs: REPORT_DAILY_WINDOW_MS,
            filedInWindow: filedInDailyWindow,
            input,
          });
        }
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
            // `daily` covers both refusals here, since both are the daily
            // ceiling binding; the member-facing difference is in `message`.
            cap: 'daily',
            message: isEmergencyReport
              ? REPORT_DAILY_EMERGENCY_ALLOWANCE_MESSAGE
              : REPORT_DAILY_CAP_MESSAGE,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      // Accepted on the allowance. Written down rather than passed through
      // silently, then allowed to fall into the per-subject check below, which
      // has its own emergency handling: a filing can legitimately clear both.
      this.recordEmergencyBypass({
        reporterId,
        cap: 'daily',
        limit: REPORT_DAILY_LIMIT,
        allowance: REPORT_DAILY_EMERGENCY_ALLOWANCE,
        windowMs: REPORT_DAILY_WINDOW_MS,
        filedInWindow: filedInDailyWindow,
        input,
      });
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
      if (isEmergencyReport) {
        this.recordEmergencyBypass({
          reporterId,
          cap: 'subject',
          // No ceiling on this one: the per-subject cap yields to an Emergency
          // filing outright, and what bounds it is the daily ceiling above.
          allowance: null,
          limit: REPORT_PER_SUBJECT_LIMIT,
          windowMs: REPORT_PER_SUBJECT_WINDOW_MS,
          filedInWindow: filedAgainstSubject,
          input,
        });
        return;
      }
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
   * The rolling flood caps for a SIGNED-OUT filing.
   *
   * Same three-part shape as `assertReportingWindowIsClear` — a daily cap with
   * a bounded Emergency allowance above it, then a per-subject cap the
   * Emergency band walks past — under the separate, tighter numbers in
   * `report-flood-limits.ts`, and keyed on `anonymousReporterKey` instead of
   * on an account. That file carries the full argument for the sizes and, more
   * importantly, for how much weaker this key is than a member id. The short
   * version: it is a peppered digest of a network address, so a determined
   * flooder buys new keys and several unrelated strangers can share one.
   *
   * ## A NULL key is not refused
   *
   * `deriveAnonymousReporterKey` returns null when there is no readable client
   * address, and this method then does nothing at all. That is deliberate, and
   * it is the one place these caps are weakest by choice: a caller who can
   * strip their address past `trust proxy` is uncapped by this layer, bounded
   * only by the burst `@Throttle`. Refusing instead would mean turning away a
   * safety report because of a proxy configuration, which is the worse
   * failure by a wide margin, and the shape it would take in practice is a
   * whole deployment where nobody signed out can report anything.
   *
   * ## Same refusal contract as the member caps
   *
   * The same 429 and the same `REPORT_FLOOD_CAP` code, with the same additive
   * `cap` field. A client cannot tell the two apart and does not need to: its
   * only question is whether this 429 carries platform-authored copy worth
   * showing, and the answer is yes either way. Only the wording differs, and
   * the wording is already in `message`.
   */
  private async assertAnonymousReportingWindowIsClear(
    anonymousReporterKey: string | null,
    input: CreateReportInput,
    severity: ReportSeverity,
  ): Promise<void> {
    if (!anonymousReporterKey) {
      return;
    }
    const now = Date.now();
    const isEmergencyReport = severity === ReportSeverity.Emergency;

    // Served by the partial index `IDX_reports_anonymous_reporter_key` on
    // (anonymous_reporter_key, created_at) as a range scan — the anonymous
    // counterpart of `IDX_reports_reporter_created_at`.
    const dailyWindowStartedAt = new Date(
      now - REPORT_ANONYMOUS_DAILY_WINDOW_MS,
    );
    const filedInDailyWindow = await this.reports.count({
      where: {
        anonymousReporterKey,
        createdAt: MoreThanOrEqual(dailyWindowStartedAt),
      },
    });
    if (filedInDailyWindow >= REPORT_ANONYMOUS_DAILY_LIMIT) {
      const hasEmergencyAllowanceLeft =
        isEmergencyReport &&
        filedInDailyWindow < REPORT_ANONYMOUS_DAILY_EMERGENCY_CEILING;

      if (!hasEmergencyAllowanceLeft) {
        if (isEmergencyReport) {
          this.recordEmergencyAllowanceExhausted({
            reporterId: null,
            anonymousReporterKey,
            limit: REPORT_ANONYMOUS_DAILY_LIMIT,
            allowance: REPORT_ANONYMOUS_DAILY_EMERGENCY_ALLOWANCE,
            windowMs: REPORT_ANONYMOUS_DAILY_WINDOW_MS,
            filedInWindow: filedInDailyWindow,
            input,
          });
        } else {
          this.recordRefusal({
            reporterId: null,
            anonymousReporterKey,
            cap: 'daily',
            limit: REPORT_ANONYMOUS_DAILY_LIMIT,
            windowMs: REPORT_ANONYMOUS_DAILY_WINDOW_MS,
            filedInWindow: filedInDailyWindow,
            input,
          });
        }
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            error: 'Too Many Requests',
            code: REPORT_FLOOD_CAP_CODE,
            cap: 'daily',
            message: isEmergencyReport
              ? REPORT_ANONYMOUS_DAILY_EMERGENCY_ALLOWANCE_MESSAGE
              : REPORT_ANONYMOUS_DAILY_CAP_MESSAGE,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      this.recordEmergencyBypass({
        reporterId: null,
        anonymousReporterKey,
        cap: 'daily',
        limit: REPORT_ANONYMOUS_DAILY_LIMIT,
        allowance: REPORT_ANONYMOUS_DAILY_EMERGENCY_ALLOWANCE,
        windowMs: REPORT_ANONYMOUS_DAILY_WINDOW_MS,
        filedInWindow: filedInDailyWindow,
        input,
      });
    }

    // Same index, one range wider, and cheap for the same reason the member
    // per-subject count is: the daily cap above bounds this key's rows inside
    // the 7-day window at roughly 7 x `REPORT_ANONYMOUS_DAILY_LIMIT`.
    const subjectWindowStartedAt = new Date(
      now - REPORT_ANONYMOUS_PER_SUBJECT_WINDOW_MS,
    );
    const filedAgainstSubject = await this.reports.count({
      where: {
        anonymousReporterKey,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        createdAt: MoreThanOrEqual(subjectWindowStartedAt),
      },
    });
    if (filedAgainstSubject >= REPORT_ANONYMOUS_PER_SUBJECT_LIMIT) {
      if (isEmergencyReport) {
        this.recordEmergencyBypass({
          reporterId: null,
          anonymousReporterKey,
          cap: 'subject',
          allowance: null,
          limit: REPORT_ANONYMOUS_PER_SUBJECT_LIMIT,
          windowMs: REPORT_ANONYMOUS_PER_SUBJECT_WINDOW_MS,
          filedInWindow: filedAgainstSubject,
          input,
        });
        return;
      }
      this.recordRefusal({
        reporterId: null,
        anonymousReporterKey,
        cap: 'subject',
        limit: REPORT_ANONYMOUS_PER_SUBJECT_LIMIT,
        windowMs: REPORT_ANONYMOUS_PER_SUBJECT_WINDOW_MS,
        filedInWindow: filedAgainstSubject,
        input,
      });
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          code: REPORT_FLOOD_CAP_CODE,
          cap: 'subject',
          message: REPORT_ANONYMOUS_PER_SUBJECT_CAP_MESSAGE,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Who the moderation log line names, as `key=value` pairs.
   *
   * A signed-in refusal names the member, exactly as it always did. A
   * signed-out one has nobody to name, so it carries a SHORT PREFIX of the
   * anonymous key instead: enough for a moderator reading a window of log
   * lines to see that twelve refusals came from one place rather than twelve,
   * which is the whole question a flood raises. The full digest stays out of
   * the log — the log stream is read by more people and kept in more places
   * than the table is, and a truncated prefix correlates without handing
   * anyone the value to compare against a `reports` row.
   *
   * `anonymous` as a literal, never an empty value, so a line about a
   * signed-out filing is unmistakably that rather than a line where the
   * reporter id failed to interpolate.
   */
  private describeReporterForLog(reporter: {
    reporterId: string | null;
    anonymousReporterKey?: string | null;
  }): string {
    if (reporter.reporterId !== null) {
      return `reporterId=${reporter.reporterId}`;
    }
    const keyPrefix = reporter.anonymousReporterKey
      ? reporter.anonymousReporterKey.slice(0, 12)
      : 'unkeyed';
    return `reporterId=anonymous anonymousKeyPrefix=${keyPrefix}`;
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
    /** NULL on the signed-out path; `anonymousReporterKey` names it instead. */
    reporterId: string | null;
    anonymousReporterKey?: string | null;
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
        `filedInWindow=${refusal.filedInWindow} ${this.describeReporterForLog(refusal)} ` +
        `subjectType=${refusal.input.subjectType} subjectId=${subjectId} ` +
        `reasonCode=${refusal.input.reasonCode}`,
    );
  }

  /**
   * An Emergency filing that walked past a cap: the per-subject one outright,
   * or the daily one on its bounded allowance.
   *
   * Not a refusal, so it increments no refusal counter and shows the member
   * nothing: the report was accepted and is on the queue. It is written down
   * because it is where a cap deliberately stops binding, and the two members
   * who reach it need opposite responses. Somebody being outed repeatedly is in
   * an escalating situation a moderator should be reading as a pattern rather
   * than as one more ticket. Somebody reaching for `outing` because it is the
   * code that gets through is abusing the band, and that is a moderation matter
   * in its own right.
   *
   * Same `Logger` and the same `key=value` shape as `recordRefusal`, with its
   * own stable grep handle (`report-flood-cap-emergency-bypass`) so the two are
   * never confused in a search. `cap=` separates the two bypasses from each
   * other, in the same vocabulary the 429 body and the refusal counter use, and
   * `allowance=` says how much room the band bought: a number on the daily
   * path, `unbounded` on the per-subject one, where the daily ceiling is what
   * bounds it instead. `subjectId` is sanitised for the same reason it is there:
   * it is the only caller-controlled value on the line. The report `detail`
   * stays out, as it does everywhere else in this file.
   *
   * No Prometheus counter: `MetricsService` exposes one report-flood counter
   * and it is a REFUSAL counter, labelled by cap. Folding an accepted filing
   * into it would corrupt the meaning of every existing point on that series.
   * A counter of its own is worth adding and belongs in `src/metrics`.
   */
  private recordEmergencyBypass(bypass: {
    /** NULL on the signed-out path; `anonymousReporterKey` names it instead. */
    reporterId: string | null;
    anonymousReporterKey?: string | null;
    cap: ReportFloodCap;
    /** Room the emergency band bought above the cap; null where it is uncapped. */
    allowance: number | null;
    limit: number;
    windowMs: number;
    filedInWindow: number;
    input: CreateReportInput;
  }): void {
    const windowHours = Math.round(bypass.windowMs / (60 * 60 * 1000));
    const subjectId = sanitizeForLogLine(bypass.input.subjectId);
    this.logger.warn(
      `report-flood-cap-emergency-bypass let an emergency filing through. ` +
        `cap=${bypass.cap} limit=${bypass.limit} ` +
        `allowance=${bypass.allowance ?? 'unbounded'} windowHours=${windowHours} ` +
        `filedInWindow=${bypass.filedInWindow} ${this.describeReporterForLog(bypass)} ` +
        `subjectType=${bypass.input.subjectType} subjectId=${subjectId} ` +
        `reasonCode=${bypass.input.reasonCode}`,
    );
  }

  /**
   * An Emergency filing refused because the daily allowance is spent too.
   *
   * The narrowest and loudest thing this service records. Reaching it means one
   * account has filed `REPORT_DAILY_EMERGENCY_CEILING` reports inside 24 hours
   * and the last of them said `outing` or `doxxing`, so the platform has just
   * turned away the one band it promises to answer within the hour. Exactly two
   * people arrive here and a moderator has to tell them apart quickly: somebody
   * whose very bad day has run past every ceiling the product has, who needs a
   * human now, and somebody who spent thirty-five filings in a day and reached
   * for the emergency band to buy the last five, which is abuse of the report
   * form at a scale nothing else in this file catches.
   *
   * Its own grep handle (`report-flood-cap-emergency-allowance-exhausted`), so
   * neither a search for ordinary refusals (`report-flood-cap refused`) nor one
   * for accepted bypasses turns it up, while the shared `report-flood-cap`
   * prefix still finds all three. `allowance=` is on the line because the
   * number is the whole story of how this refusal was reached.
   *
   * It DOES increment the refusal counter under `cap="daily"`, unlike the
   * bypass above: this filing was refused, by the daily ceiling, and leaving it
   * off the one series a moderation dashboard reads would make the worst
   * refusals the only invisible ones. A third `cap` label value would fragment
   * a series whose job is to show which cap is under pressure, so the log line
   * carries the distinction and the counter stays comparable.
   */
  private recordEmergencyAllowanceExhausted(exhausted: {
    /** NULL on the signed-out path; `anonymousReporterKey` names it instead. */
    reporterId: string | null;
    anonymousReporterKey?: string | null;
    limit: number;
    allowance: number;
    windowMs: number;
    filedInWindow: number;
    input: CreateReportInput;
  }): void {
    this.metrics.incrementReportFloodRefusal('daily');

    const windowHours = Math.round(exhausted.windowMs / (60 * 60 * 1000));
    const subjectId = sanitizeForLogLine(exhausted.input.subjectId);
    this.logger.warn(
      `report-flood-cap-emergency-allowance-exhausted refused an emergency filing. ` +
        `cap=daily limit=${exhausted.limit} allowance=${exhausted.allowance} ` +
        `windowHours=${windowHours} filedInWindow=${exhausted.filedInWindow} ` +
        `${this.describeReporterForLog(exhausted)} ` +
        `subjectType=${exhausted.input.subjectType} subjectId=${subjectId} ` +
        `reasonCode=${exhausted.input.reasonCode}`,
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
   *
   * Two more snapshots have joined it on the same argument, each with its own
   * discriminant: `housing-snapshot` for a reported home, and `photo-snapshot`
   * for ONE gathering photo. Every shape is declared in `report-evidence.ts`,
   * which also carries the reasoning for the one decision that is not obvious:
   * the photo snapshot holds the image BY REFERENCE and no copy of the
   * photograph is retained anywhere.
   */
  private buildEvidence(
    clientEvidence: CreateReportInput['evidence'],
    reportedMessage: Message | null,
    reportedHousing: HousingListing | null,
    reportedEventPhoto: EventPhoto | null,
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
    // Gathering-photo snapshot: the facts a moderator needs to judge ONE
    // photograph, captured at filing time so a later takedown cannot erase what
    // was reported. The pixels stay by reference (`storageKey`) and no copy is
    // made — the argument for that, and what would have to be built to overrule
    // it, is written out on `PhotoSnapshotEvidence` in `report-evidence.ts`.
    // Ids rather than names, matching `housing-snapshot`: this is an internal
    // moderation record and the drawer resolves display names itself.
    if (reportedEventPhoto) {
      evidence.push({
        type: PHOTO_SNAPSHOT_TYPE,
        photoId: reportedEventPhoto.id,
        eventId: reportedEventPhoto.eventId,
        storageKey: reportedEventPhoto.storageKey,
        caption: reportedEventPhoto.caption,
        uploaderId: reportedEventPhoto.uploaderId,
        uploadedAt: reportedEventPhoto.createdAt.toISOString(),
        snapshotAt: new Date().toISOString(),
      });
    }
    return evidence.length ? evidence : null;
  }
}
