import {
  Equals,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { TENANCY_MONTH_PATTERN } from '../tenancy-month';

/** POST /landlords/:slug/recommendations — upserts my one recommendation. */
export class CreateRecommendationDto {
  @IsInt() @Min(1) @Max(5) stars!: number;

  @IsString() @MinLength(10) @MaxLength(2000) text!: string;

  /**
   * PRD-249. The author attests they personally rented from this landlord.
   *
   * REQUIRED, and required to be `true`: a `false` is not a recommendation
   * anybody asked for, so `@Equals(true)` refuses it at the boundary rather
   * than storing a rating from somebody who says they were never a tenant. The
   * column behind it (`landlord_recommendations.attested_at`) is NULLABLE, and
   * that mismatch is the point: the rows written before this existed carry no
   * attestation and there is no honest value to backfill into them. See the
   * column's own comment.
   *
   * It is an attestation and nothing more. The platform cannot check it: there
   * is no lease on file, no accepted intro request required, and no way to ask
   * a landlord who is not a member. Every read says so.
   */
  @IsBoolean()
  @Equals(true, {
    message:
      'Only somebody who rented from this landlord can recommend them. Confirm that you did.',
  })
  hasRentedFromThisLandlord!: boolean;

  /**
   * Roughly when the tenancy started, as `YYYY-MM`. REQUIRED alongside the
   * attestation: "I rented from them" with no window is a claim a reader cannot
   * weigh, and the window is most of what makes the attestation worth asking
   * for. Month precision on purpose (see `tenancy-month.ts`).
   *
   * The service checks the rest: inside the accepted year range, not in the
   * future, and not after `tenancyEndedOn`.
   */
  @IsString()
  @Matches(TENANCY_MONTH_PATTERN, {
    message: 'Give the month the tenancy started, as YYYY-MM.',
  })
  tenancyStartedOn!: string;

  /**
   * Roughly when it ended, as `YYYY-MM`, or omitted when the author is STILL
   * renting from this landlord. Omitting it is a real answer rather than a
   * skipped field, which is why it is optional here and nullable in the column.
   */
  @IsOptional()
  @IsString()
  @Matches(TENANCY_MONTH_PATTERN, {
    message:
      'Give the month the tenancy ended, as YYYY-MM, or leave it out if you still rent from them.',
  })
  tenancyEndedOn?: string;
}
