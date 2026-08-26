import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * How badly an incident bites, chosen by the operator writing it up. Folded
 * into a component state by `StatusService`: `minor` and `major` both read as
 * `degraded` on the page, `critical` reads as `down`. Three severities rather
 * than two because the write-up itself wants the distinction ("slower than
 * usual" is not "half of it is failing"), while a member scanning the page
 * only ever needs to know whether a thing works.
 */
export enum StatusIncidentSeverity {
  Minor = 'minor',
  Major = 'major',
  Critical = 'critical',
}

/**
 * `open` — happening now. `monitoring` — believed fixed, still being watched;
 * still counts against the affected components, because a fix that is not yet
 * trusted is not yet a fix. `resolved` — over, and no longer affects any
 * component state.
 */
export enum StatusIncidentStatus {
  Open = 'open',
  Monitoring = 'monitoring',
  Resolved = 'resolved',
}

/**
 * One operator-authored incident on the public status page (`GET /status`).
 *
 * WHY THIS TABLE EXISTS. QueerPulse sends no email, so a member who cannot sign
 * in has no channel that can reach them and no way to tell "the platform is
 * down" from "I am banned" from "my account is broken". The derived half of the
 * status page (the probes in `src/health/`) can only answer "is Postgres
 * answering", which covers a hard outage and nothing else. Everything a person
 * actually needs told — a degraded upload path, a third-party sign-in provider
 * misbehaving, a planned migration window — has to be written by a human, and
 * this is where they write it.
 *
 * NOT USER CONTENT. Rows here are written only by `AdminStatusIncidentsService`
 * behind `@Roles(Moderator, Admin)`. `title` and `body` are rendered verbatim
 * to unauthenticated visitors, which is exactly why the write path sanitizes
 * them to plain text rather than trusting the author's keyboard.
 *
 * `authoredByLabel` is a SNAPSHOT, kept next to the nullable `authoredByUserId`
 * for the same reason `RoadmapAuditLog.actorLabel` is: the FK is
 * `ON DELETE SET NULL`, so who wrote an incident survives that person erasing
 * their account. Neither field is ever exposed publicly — see
 * `platform-status.controller.ts` on not telling anonymous visitors who
 * operates the platform.
 */
@Entity('status_incidents')
// The public read is "everything unresolved, plus recently resolved, newest
// first"; the admin list is the same read without the recency bound. Both are
// served by this one index. The explicit `started_at DESC` ordering lives in
// the migration's raw DDL — the TypeORM decorator API cannot express column
// sort order (same caveat as `RoadmapAuditLog`'s `created_at` index).
@Index('IDX_status_incidents_status_started_at', ['status', 'startedAt'])
export class StatusIncident {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 160 })
  title!: string;

  @Column({ type: 'text' })
  body!: string;

  /**
   * Which member-facing areas this incident degrades, as
   * `StatusComponentId` values. An empty array is legitimate and means
   * "worth announcing, degrades nothing" — a planned maintenance notice, say.
   * Unknown ids are dropped at read time rather than trusted, so removing a
   * component from the registry cannot break the public page.
   */
  @Column({ type: 'text', array: true, default: '{}' })
  affectedComponents!: string[];

  @Column({
    type: 'enum',
    enum: StatusIncidentSeverity,
    default: StatusIncidentSeverity.Minor,
  })
  severity!: StatusIncidentSeverity;

  @Column({
    type: 'enum',
    enum: StatusIncidentStatus,
    default: StatusIncidentStatus.Open,
  })
  status!: StatusIncidentStatus;

  /** When the trouble began, which is rarely when the row was created. */
  @Column({ type: 'timestamptz' })
  startedAt!: Date;

  /** Set when `status` becomes `resolved`, cleared if it is reopened. */
  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  authoredByUserId!: string | null;

  @Column({ type: 'varchar', length: 120 })
  authoredByLabel!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
