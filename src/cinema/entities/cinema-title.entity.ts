import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

export enum TitleKind {
  Film = 'film',
  Short = 'short',
}

export enum TitleStatus {
  Draft = 'draft',
  AwaitingUpload = 'awaiting_upload',
  Processing = 'processing',
  Ready = 'ready',
  Failed = 'failed',
}

@Entity('cinema_titles')
export class CinemaTitle {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    type: 'enum',
    enum: TitleKind,
    enumName: 'cinema_titles_kind_enum',
  })
  kind: TitleKind;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'varchar', nullable: true })
  coverImageUrl: string | null;

  @Column({
    type: 'enum',
    enum: TitleStatus,
    enumName: 'cinema_titles_status_enum',
    default: TitleStatus.Draft,
  })
  status: TitleStatus;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ type: 'varchar', nullable: true })
  muxUploadId: string | null;

  @Column({ type: 'varchar', nullable: true })
  muxAssetId: string | null;

  @Column({ type: 'varchar', nullable: true })
  muxPlaybackId: string | null;

  // In-flight replacement of a ready title: the new upload/asset live here
  // until video.asset.ready, then swap into the mux_* columns atomically.
  @Column({ type: 'varchar', nullable: true })
  pendingMuxUploadId: string | null;

  @Column({ type: 'varchar', nullable: true })
  pendingMuxAssetId: string | null;

  // Stamped on every ingest state transition (upload minted, asset created,
  // asset ready/errored). Reconciliation cuts stale in-flight titles on THIS,
  // not updated_at — view-count increments bump updated_at and would otherwise
  // hide a title that is genuinely stuck mid-ingest.
  @Column({ type: 'timestamptz', nullable: true })
  lastIngestEventAt: Date | null;

  @Column({ type: 'integer', nullable: true })
  durationSeconds: number | null;

  @Column({ type: 'varchar', nullable: true })
  aspectRatio: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @Column({ type: 'integer', default: 0 })
  viewCount: number;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'created_by' })
  createdBy: User | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
