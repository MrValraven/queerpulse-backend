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

  // Only for anonymous follow-up when the reporter has no account.
  @Column({ type: 'varchar', nullable: true })
  contactEmail!: string | null;

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
  @Column({ type: 'timestamptz' })
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

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
