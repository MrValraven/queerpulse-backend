import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One append-only entry in the admin roadmap's audit trail — every mutating
 * admin action (item/idea/team writes) logs a row here via
 * `roadmap-audit.util.ts`'s `logAudit()` helper (Task A4). Backs
 * `GET /roadmap/admin/audit` and its CSV export. `actorId` is null for
 * system-attributed actions, in which case `actorLabel` still carries a
 * display name (matches `RoadmapItemComment.authorId`/`authorLabel`).
 * The migration (Task A2) creates this index as `created_at DESC` — the
 * TypeORM decorator API doesn't express column sort order, so the exact
 * `DESC` ordering lives in the migration's raw DDL, not here.
 */
@Entity('roadmap_audit_log')
@Index('IDX_roadmap_audit_log_created_at', ['createdAt'])
export class RoadmapAuditLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  actorId!: string | null;

  @Column()
  actorLabel!: string;

  @Column({ type: 'text' })
  action!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
