import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { STUDIO_LIMITS } from '../studio.constants';
import { trimStringValue } from './create-studio-release.dto';

/** `POST /studio/releases/:id/disputes` (Studio open demo pages). */
export class CreateStudioDisputeDto {
  /** The artist's note to our team, read beside the takedown reason. */
  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_LIMITS.disputeNoteMaxLength)
  note!: string;
}
