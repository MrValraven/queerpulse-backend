import { OmitType } from '@nestjs/mapped-types';
import { CreateEventDto } from '../../events/dto/create-event.dto';

/**
 * The house wizard's body for a Music event. It is the member create body
 * minus the two fields the house route fixes itself: the event always runs
 * under the house, so a body that sends `communitySlug` or `runByListingId` is a 400.
 */
export class CreateMusicEventDto extends OmitType(CreateEventDto, [
  'communitySlug',
  'runByListingId',
] as const) {}
