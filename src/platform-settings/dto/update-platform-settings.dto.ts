import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Every field optional — this is a partial update, and the service only writes
 * (and only audits) the fields actually present. `undefined` means "leave
 * alone"; an explicit `null` on a message field means "clear it".
 *
 * The global ValidationPipe runs with `whitelist` + `forbidNonWhitelisted`, so
 * an unknown field is a 400 rather than a silently ignored typo.
 */
export class UpdatePlatformSettingsDto {
  @IsOptional()
  @IsBoolean()
  registrationEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  joinRequestsEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  lockdownEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  lockdownAllowsModerators?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  lockdownMessage?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  registrationClosedMessage?: string | null;

  /** Free-text reason, recorded on every audit row this request produces. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
