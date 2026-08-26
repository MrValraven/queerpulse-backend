import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * `POST /admin/reading-group-proposals/:id/decline` body (LOC-19).
 *
 * A decline carries a REQUIRED reason, unlike approve/archive's optional note
 * (`DecideReadingGroupProposalDto`). The proposer is told the outcome in-app
 * and on their phone, so a decline with no words attached would be a
 * notification that says only "no" about work the member actually did. The
 * reason is the message.
 *
 * `@MinLength(1)` is evaluated after the global `ValidationPipe`'s transform,
 * and the service trims before persisting, so a whitespace-only reason is
 * refused there rather than stored as a blank line.
 */
export class DeclineReadingGroupProposalDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
