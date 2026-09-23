import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Partial PATCH of a community's safety-policy settings from the admin
 * community detail's Settings tab. Every field is optional so a toggle change
 * sends only what it edits and leaves the rest untouched. The global
 * `ValidationPipe` (whitelist + forbidNonWhitelisted) rejects any other field.
 */
export class UpdateAdminCommunitySettingsDto {
  @IsOptional()
  @IsBoolean()
  requiresSecondVouch?: boolean;

  @IsOptional()
  @IsBoolean()
  autoFreezeOnReports?: boolean;

  // Platform-wide singleton — setting this `true` clears every other
  // community's `isFeatured` (see `AdminCommunitiesService.updateSettings`).
  @IsOptional()
  @IsBoolean()
  isFeatured?: boolean;

  // Staff switch that lets this community's owner and mods open spaces
  // under it. Only meaningful on a top-level community: setting it `true`
  // on a space fails with 409 `SUBCOMMUNITIES_NOT_ALLOWED` (see
  // `AdminCommunitiesService.updateSettings`). Setting it `false` leaves any
  // spaces already open in place and only blocks new ones.
  @IsOptional()
  @IsBoolean()
  allowsSubcommunities?: boolean;
}
