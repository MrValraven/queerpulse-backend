import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body shared by the admin approve/decline/archive transitions on a
 * reading-group proposal. The only field a decision carries is an optional
 * free-text note (why declined, an approval remark) — the target proposal and
 * the deciding staff member both come from the route, not the body. Empty or
 * whitespace-only notes are normalised to `null` in the service.
 */
export class DecideReadingGroupProposalDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
