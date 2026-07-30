import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

// `POST /appeals` body — a member contesting a moderation decision taken on
// them (a warn, content removal, suspension, or ban).
export class CreateAppealDto {
  /**
   * The specific moderator action being appealed — a `mod_audit_logs` row id —
   * when the member has one to hand (e.g. from a deep link in the enforcement
   * notification / their suspended screen). OPTIONAL by design: a member who
   * lands on the appeal form cold does not know this id, so the service
   * resolves the most recent enforcement action against them instead. When it
   * IS supplied, the service verifies the action was taken against this same
   * member before trusting it (ownership scoping) — a member can only appeal a
   * decision made about themselves.
   */
  @IsOptional()
  @IsUUID()
  actionId?: string;

  /**
   * The member's free-text case for why the decision should be reconsidered.
   * Bounded on both ends: a one-word "unfair" gives a reviewing moderator
   * nothing to act on, and an unbounded field is an abuse vector against a
   * `text` column.
   */
  @IsString()
  @MinLength(20)
  @MaxLength(4000)
  reason: string;
}
