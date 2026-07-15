import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// A GDPR data-subject request (access/Art.15, rectification/Art.16,
// erasure/Art.17, objection/Art.21). `reference` is the human-facing tracking
// code shown to the member (e.g. "DSAR-4F91A2B0").
export type DsarArticle = 15 | 16 | 17 | 21;

export enum DsarStatus {
  Received = 'received',
  InReview = 'in_review',
  Resolved = 'resolved',
  Rejected = 'rejected',
}

@Entity('dsar_request')
export class DsarRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_dsar_request_user_id')
  @Column({ type: 'uuid' })
  userId: string;

  @Index({ unique: true })
  @Column({ type: 'varchar' })
  reference: string;

  @Column({ type: 'smallint' })
  article: DsarArticle;

  @Column({
    type: 'enum',
    enum: DsarStatus,
    enumName: 'dsar_request_status_enum',
    default: DsarStatus.Received,
  })
  status: DsarStatus;

  @Column({ type: 'jsonb' })
  scopes: string[];

  @Column({ type: 'text' })
  details: string;

  @Column({ type: 'varchar', nullable: true })
  context: string | null;

  // Deliberately a plain column (not `@CreateDateColumn`): the service sets it
  // explicitly so `dueBy` (submittedAt + 30 days) is computed from the exact
  // same instant that gets persisted.
  @Column({ type: 'timestamptz' })
  submittedAt: Date;

  @Column({ type: 'timestamptz' })
  dueBy: Date;

  @Column({ type: 'timestamptz', nullable: true })
  respondedAt: Date | null;
}
