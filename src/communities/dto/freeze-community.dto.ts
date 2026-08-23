import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * `POST /communities/:slug/freeze` body. Entirely optional, so a caller that
 * posts no body at all still freezes the community exactly as before.
 *
 * `note` is a short PUBLIC line the moderator writes for the members
 * ("paused while we rewrite the rules", "on hold until the March meeting").
 * It is stored in `communities.frozen_note` and shown to everyone who can see
 * the community, so it carries no moderation detail: why a freeze happened
 * stays in `frozenReason` and the governance log. Sanitized to plain text on
 * write (`toStoredPlainTextOrNull`), and cleared by `unfreeze`.
 */
export class FreezeCommunityDto {
  @IsOptional() @IsString() @MaxLength(200) note?: string | null;
}
