import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * A moderator hiding (or un-hiding) a group listing for a norm violation.
 *
 * `reason` is REQUIRED when hiding (PRD-463): it is recorded on the row, sent
 * to the poster in their `GroupListingDecided` notice, and written into the
 * audit note. A takedown the poster cannot read a sentence about is the
 * failure this field exists to stop. When un-hiding, the validators are
 * skipped and any `reason` sent is ignored.
 */
export class HideGroupListingDto {
  @IsBoolean()
  hidden!: boolean;

  @ValidateIf((dto: HideGroupListingDto) => dto.hidden === true)
  @IsString()
  @Transform(trimmed)
  @IsNotEmpty()
  @MaxLength(500)
  reason?: string;
}
