import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Reason codes for events QueerPulse hosts in Music. Each one answers with
 * the body `{ statusCode, code, message }`, so the frontend names the cause of
 * every refusal. The statuses and messages follow section 5.1 of the Music
 * manager and producer contract.
 */
export type HouseMusicEventErrorCode =
  | 'music_event_not_found'
  | 'house_event_family_locked'
  | 'music_event_community_unavailable'
  | 'music_event_performer_not_studio_artist'
  | 'music_event_cohost_is_you'
  | 'music_event_cohost_holds_grant'
  | 'music_event_cohost_is_staff_tier'
  | 'music_event_cohost_not_active'
  | 'music_event_member_not_found'
  | 'music_event_invite_request_not_found';

export const HOUSE_MUSIC_EVENT_ERRORS: Readonly<
  Record<HouseMusicEventErrorCode, { status: HttpStatus; message: string }>
> = {
  music_event_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'This event is not one QueerPulse hosts in Music.',
  },
  house_event_family_locked: {
    status: HttpStatus.FORBIDDEN,
    message: 'An event QueerPulse hosts keeps the family it was filed in.',
  },
  music_event_community_unavailable: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A QueerPulse music event cannot be community-only.',
  },
  // A block either way with the staff member answers this code too, so a
  // refusal never reveals a block.
  music_event_performer_not_studio_artist: {
    status: HttpStatus.FORBIDDEN,
    message: 'Only Studio artists can be booked onto this lineup.',
  },
  music_event_cohost_is_you: {
    status: HttpStatus.FORBIDDEN,
    message:
      'You run this event for QueerPulse, so you cannot also co-host it.',
  },
  music_event_cohost_holds_grant: {
    status: HttpStatus.FORBIDDEN,
    message:
      'A music manager and producer cannot co-host a QueerPulse music event.',
  },
  music_event_cohost_is_staff_tier: {
    status: HttpStatus.FORBIDDEN,
    message: 'Moderators and admins cannot co-host a QueerPulse music event.',
  },
  music_event_cohost_not_active: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Co-hosts must be active members.',
  },
  music_event_member_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'No member has this profile address.',
  },
  music_event_invite_request_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'This invite request is not on this event.',
  },
};

export function houseMusicEventError(
  code: HouseMusicEventErrorCode,
): HttpException {
  const { status, message } = HOUSE_MUSIC_EVENT_ERRORS[code];
  return new HttpException({ statusCode: status, code, message }, status);
}
