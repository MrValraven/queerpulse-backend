import { OmitType } from '@nestjs/mapped-types';
import { IsIn } from 'class-validator';
import {
  RSVP_DETAILS_VISIBILITY_OPTIONS,
  RsvpDetailsVisibility,
} from '../entities/event-rsvp.entity';
import { UpdateRsvpDetailsDto } from './update-rsvp-details.dto';

/**
 * The RSVP details an invitee sends while accepting an invite. Saved in the
 * same transaction as the RSVP itself (`RsvpService.acceptInviteRsvp`).
 *
 * An invitee arrives alone, so `guestCount` is left out and sending one is a
 * 400 that names the field. `visibility` is required: the accept flow always
 * asks who may see the invitee on the attendee list.
 */
export class AcceptInviteDetailsDto extends OmitType(UpdateRsvpDetailsDto, [
  'guestCount',
  'visibility',
] as const) {
  @IsIn(RSVP_DETAILS_VISIBILITY_OPTIONS)
  visibility!: RsvpDetailsVisibility;
}
