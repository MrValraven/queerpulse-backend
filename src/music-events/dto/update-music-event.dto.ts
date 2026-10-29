import { OmitType, PartialType } from '@nestjs/mapped-types';
import { CreateMusicEventDto } from './create-music-event.dto';

/**
 * `recurrence` is CREATE-only, as on `UpdateEventDto`: a PATCH can never turn
 * a standalone Music event into a series.
 */
export class UpdateMusicEventDto extends PartialType(
  OmitType(CreateMusicEventDto, ['recurrence'] as const),
) {}
