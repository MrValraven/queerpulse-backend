import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { SubmissionDecision } from '../entities/magazine-story-submission.entity';

const DECISIONS: SubmissionDecision[] = [
  'accepted',
  'declined',
  'commissioned',
];

/**
 * Body of `PATCH /admin/magazine-submissions/:id`. Mirrors
 * `TriageWriterApplicationDto`: the verdict plus an optional note written back
 * to the submitter, which is the only prose the member ever receives about the
 * decision (QueerPulse sends no email — the note reaches them on their tracker
 * card and through the in-app bell).
 */
export class DecideStorySubmissionDto {
  @IsIn(DECISIONS)
  decision!: SubmissionDecision;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  replyNote?: string;
}
