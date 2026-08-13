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
}
