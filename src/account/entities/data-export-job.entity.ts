import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// A data-portability (Art. 20) export job. This backend builds the archive
// payload synchronously (no worker/queue in this scaffold), so a job is
// created already `Ready` with `data` populated — `GET
// /account/export/:jobId` then returns it as the frontend's `ExportJob`
// envelope (`features/settings/api/account.api.ts`), gating the download link
// on `status === 'ready'`.
export enum DataExportStatus {
  Queued = 'queued',
  Processing = 'processing',
  Ready = 'ready',
  Failed = 'failed',
  Expired = 'expired',
}

export enum DataExportFormat {
  Json = 'json',
  Csv = 'csv',
  Both = 'both',
}

@Entity('data_export_job')
export class DataExportJob {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_data_export_job_user_id')
  @Column({ type: 'uuid' })
  userId: string;

  @Column({
    type: 'enum',
    enum: DataExportStatus,
    enumName: 'data_export_job_status_enum',
    default: DataExportStatus.Queued,
  })
  status: DataExportStatus;

  @Column({ type: 'jsonb' })
  categories: string[];

  @Column({
    type: 'enum',
    enum: DataExportFormat,
    enumName: 'data_export_job_format_enum',
  })
  format: DataExportFormat;

  @Column({ type: 'timestamptz' })
  requestedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  generatedAt: Date | null;

  @Column({ type: 'jsonb', nullable: true })
  data: Record<string, unknown> | null;

  @Column({ type: 'varchar', nullable: true })
  error: string | null;
}
