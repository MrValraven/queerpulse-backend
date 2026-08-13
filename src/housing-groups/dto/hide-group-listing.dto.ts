import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * A moderator hiding (or un-hiding) a group listing for a norm violation.
 * `reason` is recorded on the row when hiding; ignored when un-hiding.
 */
export class HideGroupListingDto {
  @IsBoolean()
  hidden!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
