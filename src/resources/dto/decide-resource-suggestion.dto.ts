import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body shared by the admin approve/decline/archive transitions on a resource
 * suggestion — mirrors `DecideReadingGroupProposalDto` exactly. The only
 * field a decision carries is an optional free-text note; the target
 * suggestion and the deciding staff member both come from the route/session,
 * not the body.
 *
 * THE NOTE IS READ BY THE MEMBER WHO SUBMITTED (PRD-45). It is carried on the
 * decision notification and on `GET /resources/suggestions/mine`, so write it
 * as a reply to that person. There is no internal-notes field on
 * `resource_suggestion` and this one is not it; anything that belongs only to
 * staff belongs in the moderation log instead.
 */
export class DecideResourceSuggestionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
