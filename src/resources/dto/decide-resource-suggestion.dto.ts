import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body shared by the admin approve/decline/archive transitions on a resource
 * suggestion — mirrors `DecideReadingGroupProposalDto` exactly. The only
 * field a decision carries is an optional free-text note; the target
 * suggestion and the deciding staff member both come from the route/session,
 * not the body.
 */
export class DecideResourceSuggestionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
