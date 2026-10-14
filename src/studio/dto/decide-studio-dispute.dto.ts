import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { STUDIO_LIMITS } from '../studio.constants';
import { trimStringValue } from './create-studio-release.dto';

/** `POST /admin/studio/disputes/:id/uphold` and `/reject`. */
export class DecideStudioDisputeDto {
  /** Shown to the release's owners on the release page. */
  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_LIMITS.disputeReplyMaxLength)
  reply!: string;
}
