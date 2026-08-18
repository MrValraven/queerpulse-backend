import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export type WriterApplicationTriageStatus = 'approved' | 'declined';
const TRIAGE_STATUSES: WriterApplicationTriageStatus[] = [
  'approved',
  'declined',
];

export class TriageWriterApplicationDto {
  @IsIn(TRIAGE_STATUSES)
  status!: WriterApplicationTriageStatus;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reviewNote?: string;
}
