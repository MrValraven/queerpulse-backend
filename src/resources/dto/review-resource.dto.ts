import { IsDateString, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * "I have read this guide end to end and it is still accurate." Separate from
 * `UpdateResourceDto` on purpose: stamping a review is a distinct editorial
 * act from changing the prose, and conflating them would let a typo fix
 * silently reset a crisis guide's freshness clock.
 */
export class ReviewResourceDto {
  /** ISO date (YYYY-MM-DD). Defaults to today when omitted. */
  @IsOptional() @IsDateString() lastReviewedOn?: string;

  /** Person or team taking responsibility, e.g. "Trans Hub". */
  @IsString() @MaxLength(120) reviewedBy!: string;

  /** When it should be read again. Omitted leaves the existing due date. */
  @IsOptional() @IsDateString() reviewDueOn?: string;
}
