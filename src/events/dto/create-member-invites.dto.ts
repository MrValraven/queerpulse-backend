import { ArrayMaxSize, ArrayMinSize, IsArray, IsString } from 'class-validator';
import { MAX_RSVP_GUESTS } from '../gathering-extras';

/**
 * The connections a member invites to an event they RSVPed to. At most
 * `MAX_RSVP_GUESTS` per request, since no inviter can hold more open invites
 * than the guest cap anyway (`MemberEventInvitesService.createMemberInvites`).
 */
export class CreateMemberInvitesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_RSVP_GUESTS)
  @IsString({ each: true })
  slugs!: string[];
}
