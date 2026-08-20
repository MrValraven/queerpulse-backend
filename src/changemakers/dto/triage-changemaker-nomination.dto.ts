import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/** Mirrors `TriageWriterApplicationDto` — see that file for the pattern this
 *  is copied from. `'dismissed'` rather than `'declined'`: there's no role
 *  grant riding on the decision here, just a yes/no on the directory pitch. */
export type ChangemakerNominationTriageStatus = 'approved' | 'dismissed';
const TRIAGE_STATUSES: ChangemakerNominationTriageStatus[] = [
  'approved',
  'dismissed',
];

export class TriageChangemakerNominationDto {
  @IsIn(TRIAGE_STATUSES)
  status!: ChangemakerNominationTriageStatus;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reviewNote?: string;
}
