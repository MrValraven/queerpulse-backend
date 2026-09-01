import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ReportSubjectType } from '../../reports/entities/report.entity';
import { reasonsFor, type ReasonCode } from '../../reports/reason-catalogue';

/**
 * The reason codes a landlord-recommendation takedown may cite.
 *
 * Derived from the shared catalogue rather than hand-listed here, so this can
 * never drift from the set the member-facing report form offers for the same
 * subject. A hand-curated copy of a taxonomy beside the taxonomy it mirrors is
 * exactly the kind of silent divergence that has already cost this platform an
 * emergency severity band.
 */
export const LANDLORD_RECOMMENDATION_REASON_CODES: readonly ReasonCode[] =
  reasonsFor(ReportSubjectType.LandlordRecommendation).map(
    (option) => option.code,
  );

/**
 * A moderator takes ONE tenant's recommendation of a landlord down.
 *
 * `note` is REQUIRED, unlike the reason on most admin routes. These
 * recommendations are how tenants warn each other about landlords on a queer
 * housing platform, so the writer is by construction the party with less power
 * in the relationship being described. A takedown here has to be a decision
 * someone recorded a reason for, and the reason is what a second moderator
 * reads when the author asks for it back.
 */
export class TakeDownRecommendationDto {
  /**
   * `hide_content` withholds the recommendation while leaving the words
   * intact; `remove_content` tombstones it. Both are reversible through
   * `DELETE /admin/landlords/recommendations/:id/takedown`. Defaults to
   * `hide_content`: the lighter action is the one a moderator should have to
   * opt out of.
   */
  @IsOptional()
  @IsIn(['hide_content', 'remove_content'])
  action?: 'hide_content' | 'remove_content';

  @IsOptional()
  @IsIn(LANDLORD_RECOMMENDATION_REASON_CODES)
  reasonCode?: ReasonCode;

  @IsString()
  @MaxLength(1000)
  note!: string;
}
