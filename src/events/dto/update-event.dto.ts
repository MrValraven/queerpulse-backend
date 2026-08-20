import { OmitType, PartialType } from '@nestjs/mapped-types';
import { CreateEventDto } from './create-event.dto';

// `recurrence` is CREATE-only (see `CreateEventDto.recurrence`'s doc) —
// omitted here so a PATCH can never retroactively turn a standalone event
// into a series.
export class UpdateEventDto extends PartialType(
  OmitType(CreateEventDto, ['recurrence'] as const),
) {}
