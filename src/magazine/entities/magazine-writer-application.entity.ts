import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum WriterApplicationStatus {
  Pending = 'pending',
  Approved = 'approved',
  Declined = 'declined',
}

/**
 * A member's application to become a magazine writer: a pitch note plus a
 * writing sample (pasted text and/or a link), triaged by an admin. On
 * approval the admin grants the existing `magazine_writer` staff role via
 * `AdminMembersService.grantStaffRole` — this entity only tracks the
 * application itself. Mirrors `CommunityJoinRequest`: the "at most one
 * pending application per user" rule is enforced by a partial unique index
 * in the migration, not a TypeORM decorator, so a user can re-apply after a
 * decline while a concurrent double-submit 23505s (mapped to 409 by the
 * service).
 */
@Entity('magazine_writer_applications')
@Index('UQ_magazine_writer_applications_pending', ['userId'], {
  unique: true,
  where: `"status" = 'pending'`,
})
export class MagazineWriterApplication {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_magazine_writer_applications_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'text', nullable: true })
  pitchNote!: string | null;

  @Column({ type: 'text', nullable: true })
  sampleText!: string | null;

  @Column({ type: 'varchar', nullable: true })
  sampleLink!: string | null;

  @Column({
    type: 'enum',
    enum: WriterApplicationStatus,
    enumName: 'magazine_writer_applications_status_enum',
    default: WriterApplicationStatus.Pending,
  })
  status!: WriterApplicationStatus;

  // Indexed (CNT-20): Postgres does not index a foreign-key column
  // automatically, so without this every hard delete of a `users` row (the
  // account-erasure path) sequentially scanned this table to fix up the
  // ON DELETE SET NULL. Created by
  // `1793640000000-AddContentModuleForeignKeyIndexes`.
  @Index('IDX_magazine_writer_applications_reviewed_by')
  @Column({ type: 'uuid', nullable: true })
  reviewedBy!: string | null;

  @Column({ type: 'text', nullable: true })
  reviewNote!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt!: Date | null;
}
