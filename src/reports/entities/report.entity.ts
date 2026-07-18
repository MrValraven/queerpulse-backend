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
export class Report {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_reports_subject')
  @Column({
    type: 'enum',
    enum: ReportSubjectType,
    enumName: 'reports_subject_type_enum',
  })
  subjectType: ReportSubjectType;

  @Column({ type: 'varchar' })
  subjectId: string;

  // Server-owned reason taxonomy code (see `../reason-catalogue.ts`) — renamed
  // from the stale `reason` free-string column (C2).
  @Column({ type: 'varchar' })
  reasonCode: string;

  @Column({ type: 'text', nullable: true })
  detail: string | null;

  // Shields the reporter's identity from mods + the reported party.
  @Column({ type: 'boolean', default: false })
  anonymous: boolean;

  // Only for anonymous follow-up when the reporter has no account.
  @Column({ type: 'varchar', nullable: true })
  contactEmail: string | null;

  // `ReportEvidence[]` as sent by the frontend (`{type:'url',value} |
  // {type:'screenshot',uploadId}`), stored verbatim. Typed `unknown[]` (not
  // `Record<string, unknown>[]`) so TypeORM's `create()` doesn't reject the
  // concrete `ReportEvidenceInput` shape for lacking an index signature.
  @Column({ type: 'jsonb', nullable: true })
  evidence: unknown[] | null;

  // Derived server-side from `reasonCode` at creation (see
  // `../report-severity.ts`) — drives `slaDueAt` and the moderation queue's
  // priority sort/filter.
  @Index('IDX_reports_severity')
  @Column({
    type: 'enum',
    enum: ReportSeverity,
    enumName: 'reports_severity_enum',
  })
  severity: ReportSeverity;

  // Computed at creation from `severity` (see `../report-severity.ts`).
  @Column({ type: 'timestamptz' })
  slaDueAt: Date;

  @Index('IDX_reports_status')
  @Column({
    type: 'enum',
    enum: ReportStatus,
    enumName: 'reports_status_enum',
    default: ReportStatus.Open,
  })
  status: ReportStatus;

  // Nullable since `AddDeletionErasureSupport1782800700000`: when the reporter
  // erases their account this is NULLed (FK is `ON DELETE SET NULL`) so the
  // report itself SURVIVES. Reports a member filed against other people are
  // moderation history about those people — erasing your own account must not
  // wipe the evidence trail against everyone you reported. Always non-null at
  // write time (`ReportsService.create`); only erasure produces a NULL.
  @Index('IDX_reports_reporter_id')
  @Column({ type: 'uuid', nullable: true })
  reporterId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
