import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

// Mirrors the frontend's `ReportSubjectType`
// (`queerpulse/src/features/safety/reportReasons.ts`) exactly — the set of
// surfaces any member can report. This is the *live* contract the
// member-facing `POST /reports` + `GET /reports/reasons` and the
// moderator-facing `GET /mod/reports` endpoints are built against (NOT the
// stale `src/shared/contracts/contracts.ts`, which used a disjoint vocabulary
// — see `.superpowers/sdd/connect-FINAL-review.md` C3).
export enum ReportSubjectType {
  Member = 'member',
  Post = 'post',
  Reply = 'reply',
  Venue = 'venue',
  Message = 'message',
  Community = 'community',
  Housing = 'housing',
  Flatmate = 'flatmate',
  Landlord = 'landlord',
  Listing = 'listing',
  Event = 'event',
  Business = 'business',
  Company = 'company',
  Job = 'job',
  Subprofile = 'subprofile',
  // A review of a directory listing (`listing_reviews`), addressed by the
  // review's uuid. Added so a moderator can take a review down: a
  // `hide_content`/`remove_content` on a `review` subject writes a
  // `content_moderation` row that `DirectoryService`'s review reads filter on.
  // Backed by `AddReviewReportSubject` (adds the value to
  // `reports_subject_type_enum`).
  Review = 'review',
  // A public reader comment on a magazine article (`magazine_reader_comment`
  // — CNT-10), addressed by the comment's uuid. Backed by
  // `AddMagazineReaderComments1793100000000` (adds the value to
  // `reports_subject_type_enum`).
  MagazineComment = 'magazine_comment',
  // A member's PUBLIC question on a business listing, or the answer posted
  // under it (`listing_public_questions`), addressed by the question's uuid.
  //
  // ONE subject covers the pair, not two. That follows the `review` precedent
  // directly above: a review's owner reply is not separately takedown-able
  // either, because a reply read without the review it answers is not the same
  // statement. A question and its answer are one exchange on the page, and a
  // moderator hiding half of it would leave the other half misread.
  //
  // Backed by `AddListingPublicQuestionReportSubject1794290000000` (adds the
  // value to `reports_subject_type_enum`).
  ListingPublicQuestion = 'listing_public_question',
  // ONE photograph in a gathering's album (`event_photos`), addressed by the
  // photo's uuid.
  //
  // `Event` already existed, and it is the wrong grain for this: acting on it
  // takes down the whole gathering over one image. Until this value existed a
  // photo of an identifiable person at a queer event could be removed only by
  // the member who uploaded it or by an organizer, which on the reports that
  // matter most is the very people being complained about. That is why this is
  // the one place the taxonomy is worth widening.
  //
  // Backed by `AddPhotoAndRecommendationReportSubjects1797700000000`.
  EventPhoto = 'event_photo',
  // ONE tenant's recommendation of a landlord (`landlord_recommendations`),
  // addressed by the recommendation's uuid.
  //
  // Same grain problem as above, and sharper: `Landlord` reports the whole
  // directory entry, so acting on a complaint about one recommendation takes
  // down every other tenant's warning about that landlord with it. These
  // recommendations are how tenants warn each other, so removing them wholesale
  // is the failure mode to avoid.
  //
  // Backed by `AddPhotoAndRecommendationReportSubjects1797700000000`.
  LandlordRecommendation = 'landlord_recommendation',
  // ONE volunteering opportunity (`volunteer_opportunities`), addressed by the
  // opportunity's SLUG — the same handle `GET /volunteering/:slug` and the
  // public opportunity page use, so what a reporter's browser already holds is
  // what the report carries.
  //
  // The grain problem here is that there was no grain at all: nothing in this
  // taxonomy reached the volunteering directory, so the only way to raise a
  // scam posting, an unsafe placement or a host org that is not affirming was
  // the Contact form, which is a different queue with no subject attached.
  // `Job` is the nearest-looking neighbour and it is the wrong one: a `job`
  // subject is a slug in the PAID-work directory (`src/companies`), a
  // different table entirely, so a moderator acting on one would have been
  // acting on nothing. An opportunity asks a member to hand a stranger their
  // unpaid time and often to turn up somewhere in person, which is exactly the
  // kind of ask that has to be reportable.
  //
  // Backed by
  // `AddVolunteeringReportSubjectAndAnonymousFloodKey1813000000000` (adds the
  // value to `reports_subject_type_enum`).
  Volunteering = 'volunteering',
}

// Mirrors the frontend's `ReportDTO`/`ModReportDTO` status union
// (`queerpulse/src/features/safety/api/reports.api.ts`,
// `queerpulse/src/features/admin/api/moderation.api.ts`): open|resolved|escalated.
export enum ReportStatus {
  Open = 'open',
  Resolved = 'resolved',
  Escalated = 'escalated',
}

// Mirrors `ModSeverity` (`moderation.api.ts`). Derived server-side from
// `reasonCode` at creation time — the reporter never chooses it (see
// `../report-severity.ts`).
export enum ReportSeverity {
  Emergency = 'emergency',
  High = 'high',
  Medium = 'medium',
  Low = 'low',
}

/**
 * A member-filed report against some subject (a member, a post, a reply, a
 * venue, a message, or a community). `subjectId` is stored as `varchar`
 * rather than `uuid` because subjects are addressed differently across
 * domains (uuid for members/messages, slug for members/communities, content
 * id for posts/replies, safe-space id for venues) — this table doesn't own or
 * validate the referenced row, it just records what was reported.
 *
 * Read by the `moderation` module (`ModerationModule` imports `ReportsModule`
 * to get `Repository<Report>` via the re-exported `TypeOrmModule`, mirroring
 * `UsersModule`'s `exports: [TypeOrmModule, UsersService]` precedent) — the
 * moderation queue, detail, actions, and audit trail all operate on this same
 * table.
 */
@Entity('reports')
// De-dupe guard for `ReportsService.create`: at most one OPEN report per
// (reporter, subject, reasonCode). Partial (`WHERE status = 'open'`) so a member
// can file afresh once a prior report is resolved/escalated. `reasonCode` is
// part of the key so two DISTINCT reasons on the same subject (e.g. a
// `listing_dispute` then a higher-severity abuse report on the same listing)
// are both allowed — only same-reason duplicates collapse. Backs the
// check-then-insert against a concurrent-duplicate race — matches
// `UQ_reports_open_reporter_subject` as rebuilt in
// `1785902300000-AddReasonCodeToReportsOpenDedupeIndex` (superseding the
// reasonCode-less shape created in `1785003000000-AddReportsOpenDedupeIndex`).
@Index(
  'UQ_reports_open_reporter_subject',
  ['reporterId', 'subjectType', 'subjectId', 'reasonCode'],
  {
    unique: true,
    where: `"status" = 'open'`,
  },
)
// The rolling anonymous flood caps (`ReportsService
// .assertAnonymousReportingWindowIsClear`) run TWO counts on the filing path,
// and this is what keeps both off a full table scan. Shaped exactly like
// `IDX_reports_reporter_created_at`, which does the same job for the per-member
// caps: the daily count is a clean range scan over (key, created_at), and the
// per-subject count reuses the same range and filters the subject columns over
// what the daily cap has already bounded to a couple of hundred tuples at the
// very worst. A subject-bearing index of its own would buy nothing over that.
//
// PARTIAL (`WHERE "anonymous_reporter_key" IS NOT NULL`) because the column is
// NULL on every signed-in report and those rows are the bulk of the table:
// including them would cost an index entry per insert and serve no read.
//
// NOT unique. Two anonymous filings under one key are exactly what the caps
// count, so they have to be allowed to exist in order to be counted, and
// collapsing them would silently discard one stranger's report into another's
// (see `ReportsService.create` on why the anonymous path does not dedupe).
//
// Backed by `AddVolunteeringReportSubjectAndAnonymousFloodKey1813000000000`.
@Index(
  'IDX_reports_anonymous_reporter_key',
  ['anonymousReporterKey', 'createdAt'],
  { where: `"anonymous_reporter_key" IS NOT NULL` },
)
export class Report {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_reports_subject')
  @Column({
    type: 'enum',
    enum: ReportSubjectType,
    enumName: 'reports_subject_type_enum',
  })
  subjectType!: ReportSubjectType;

  @Column({ type: 'varchar' })
  subjectId!: string;

  // Server-owned reason taxonomy code (see `../reason-catalogue.ts`) — renamed
  // from the stale `reason` free-string column (C2).
  @Column({ type: 'varchar' })
  reasonCode!: string;

  @Column({ type: 'text', nullable: true })
  detail!: string | null;

  // Shields the reporter's identity from mods + the reported party.
  @Column({ type: 'boolean', default: false })
  anonymous!: boolean;

  // An off-platform address a SIGNED-OUT reporter chose to leave, so a human
  // on the safety team can decide to reach out by hand. Nothing sends to it:
  // QueerPulse delivers no email and never will, so this is a note in a
  // moderator's file rather than an address in a queue.
  //
  // Only ever populated when `reporterId` is NULL, and the rule is enforced on
  // the WRITE path (`ReportsService.create`), never left to the client. A
  // signed-in member is already reachable through the notification bell, and
  // `GET /reports/mine` shows them their own report's status without anyone
  // contacting them at all, so an address stored beside their account buys
  // nothing and costs a second copy of their personal data sitting on a
  // moderation row. A signed-in filing that carries `contactEmail` therefore
  // stores NULL here; the field is accepted and dropped rather than refused,
  // because the report itself is the thing that matters.
  @Column({ type: 'varchar', nullable: true })
  contactEmail!: string | null;

  /**
   * The durable flood-cap key for a SIGNED-OUT filing: an HMAC-SHA256 digest
   * of the reporter's client IP under a server-held pepper, never the address
   * itself. See `../anonymous-reporter-key.ts` for how it is derived and
   * `../report-flood-limits.ts` for what it bounds and how weak it is.
   *
   * NULL on every signed-in report, because those are capped per MEMBER off
   * `reporterId` and nothing here would add to that. NULL is also what a
   * signed-out filing stores when no client address could be read at all, and
   * the caps treat that as "uncapped by this layer" rather than refusing: a
   * report from somebody the server cannot key is still a report.
   *
   * Served by the PARTIAL index `IDX_reports_anonymous_reporter_key` declared
   * on the class below. Partial because the column is NULL on every signed-in
   * row, and those are the overwhelming majority: indexing them would be dead
   * weight on every insert for no read.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  anonymousReporterKey!: string | null;

  // `ReportEvidence[]` as sent by the frontend (`{type:'url',value} |
  // {type:'screenshot',uploadId}`), stored verbatim. Typed `unknown[]` (not
  // `Record<string, unknown>[]`) so TypeORM's `create()` doesn't reject the
  // concrete `ReportEvidenceInput` shape for lacking an index signature.
  @Column({ type: 'jsonb', nullable: true })
  evidence!: unknown[] | null;

  // Derived server-side from `reasonCode` at creation (see
  // `../report-severity.ts`) — drives `slaDueAt` and the moderation queue's
  // priority sort/filter.
  @Index('IDX_reports_severity')
  @Column({
    type: 'enum',
    enum: ReportSeverity,
    enumName: 'reports_severity_enum',
  })
  severity!: ReportSeverity;

  // Computed at creation from `severity` (see `../report-severity.ts`).
  //
  // Millisecond precision (not Postgres's microsecond default), like
  // `createdAt` below: the moderation queue's `sort=priority` page is a keyset
  // over this raw column, and `cursorPaginate` carries a millisecond-resolution
  // JS `Date` cursor — a microsecond tail would re-serve the boundary row on
  // the next page. See `1793520300000-NarrowReportCursorPrecision.ts`.
  @Column({ type: 'timestamptz', precision: 3 })
  slaDueAt!: Date;

  @Index('IDX_reports_status')
  @Column({
    type: 'enum',
    enum: ReportStatus,
    enumName: 'reports_status_enum',
    default: ReportStatus.Open,
  })
  status!: ReportStatus;

  // Nullable since `AddDeletionErasureSupport1782800700000`: when the reporter
  // erases their account this is NULLed (FK is `ON DELETE SET NULL`) so the
  // report itself SURVIVES. Reports a member filed against other people are
  // moderation history about those people — erasing your own account must not
  // wipe the evidence trail against everyone you reported. Always non-null at
  // write time (`ReportsService.create`); only erasure produces a NULL.
  @Index('IDX_reports_reporter_id')
  @Column({ type: 'uuid', nullable: true })
  reporterId!: string | null;

  // The moderator who has claimed this report (COM-5). Nullable — NULL means
  // unassigned. `ON DELETE SET NULL` (see `AddReportAssignee`): the report
  // reverts to unassigned rather than blocking the erasure sweep when the
  // assigning moderator erases their account.
  @Index('IDX_reports_assigned_moderator_id')
  @Column({ type: 'uuid', nullable: true })
  assignedModeratorId!: string | null;

  // Set together with `assignedModeratorId`, cleared together on unassign —
  // mirrors `forum_thread.pinnedAt`'s pin-watermark pattern.
  @Column({ type: 'timestamptz', nullable: true })
  assignedAt!: Date | null;

  // --- resolution (COM-7): denormalized onto the row at the moment
  // `actOnReport`/`bulkActOnReports` resolves the report, so the resolved-tab
  // queue never needs a join to show the outcome. NULL `resolvedAt` = never
  // resolved (open/escalated). See `AddReportResolution` for the erasure-safe
  // shape of `resolutionActorId`. ---

  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  resolutionActorId!: string | null;

  // The `ModActionCode` that resolved the report (e.g. "restrict"/"suspend").
  @Column({ type: 'varchar', nullable: true })
  resolutionAction!: string | null;

  // e.g. "7d" — only set for a duration-bearing resolution (restrict/suspend).
  @Column({ type: 'varchar', nullable: true })
  resolutionDuration!: string | null;

  // The exact member-facing text the resolving moderator wrote.
  @Column({ type: 'text', nullable: true })
  resolutionNote!: string | null;

  // Which parties the outcome was actually communicated to —
  // `ResolutionNotifiedParty[]` ("member" | "reporter" | "affected").
  @Column({ type: 'varchar', array: true, nullable: true })
  resolutionNotified!: string[] | null;

  // Millisecond precision — see `slaDueAt` above and
  // `1793520300000-NarrowReportCursorPrecision.ts`. Backs both the default
  // newest-first cursor page and `sort=age`.
  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt!: Date;
}
