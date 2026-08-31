import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body for `PATCH /admin/ban-evasion/escalations/:id` (moderator or admin).
 *
 * Closing an escalation is the staff half of the loop: it records that somebody
 * looked, and it releases the "one open escalation per (community, join
 * request)" lock so the community can ask again later if the applicant comes
 * back. `resolutionNote` stays on the staff console and is never returned on
 * any community-scoped surface.
 */
export class ResolveBanEvasionEscalationDto {
  @IsOptional() @IsString() @MaxLength(2000) resolutionNote?: string;
}
