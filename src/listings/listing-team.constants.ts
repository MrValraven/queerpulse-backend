import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';

/** Caps and timing of the "Meet the team" link between a listing and a persona. */
export const LISTING_TEAM_LIMITS = {
  acceptedPerListing: 40,
  pendingPerListing: 40,
  acceptedPerPersona: 10,
  pendingRequestsPerPersona: 10,
  cooldownDays: 14,
  roleLabelMax: 40,
} as const;

/** Bounds of the two team search routes and of the persona's invites list. */
export const LISTING_TEAM_SEARCH = {
  queryMinLength: 2,
  queryMaxLength: 60,
  resultsMax: 20,
  invitesReceivedMax: 100,
} as const;

export type ListingTeamErrorCode =
  | 'listing_team_persona_not_found'
  | 'listing_team_listing_not_found'
  | 'listing_team_link_not_found'
  | 'listing_team_persona_ineligible'
  | 'listing_team_listing_not_live'
  | 'listing_team_already_pending'
  | 'listing_team_already_accepted'
  | 'listing_team_cooldown'
  | 'listing_team_full'
  | 'listing_team_pending_full'
  | 'listing_team_persona_full'
  | 'listing_team_persona_requests_full'
  | 'listing_team_not_pending'
  | 'listing_team_not_accepted'
  | 'listing_team_order_mismatch';

export const LISTING_TEAM_ERRORS: Record<
  ListingTeamErrorCode,
  { status: HttpStatus; message: string }
> = {
  listing_team_persona_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'This persona is not available.',
  },
  listing_team_listing_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'This business is not available.',
  },
  listing_team_link_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'This team link is not available.',
  },
  listing_team_persona_ineligible: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message:
      'This persona needs to be published, with a handle, and visible to members or everyone before it can join a team.',
  },
  listing_team_listing_not_live: {
    status: HttpStatus.CONFLICT,
    message:
      'This business page needs to be live and visible before its team can change.',
  },
  listing_team_already_pending: {
    status: HttpStatus.CONFLICT,
    message:
      'An invite or request between these two is already waiting for an answer.',
  },
  listing_team_already_accepted: {
    status: HttpStatus.CONFLICT,
    message: 'This persona is already on the team.',
  },
  listing_team_cooldown: {
    status: HttpStatus.CONFLICT,
    message:
      'This was declined recently. You can ask again from the date shown.',
  },
  listing_team_full: {
    status: HttpStatus.CONFLICT,
    message: 'This team already has 40 members.',
  },
  listing_team_pending_full: {
    status: HttpStatus.CONFLICT,
    message: 'This business already has 40 invites and requests waiting.',
  },
  listing_team_persona_full: {
    status: HttpStatus.CONFLICT,
    message: 'This persona is already on 10 teams.',
  },
  listing_team_persona_requests_full: {
    status: HttpStatus.CONFLICT,
    message: 'This persona already has 10 requests waiting.',
  },
  listing_team_not_pending: {
    status: HttpStatus.CONFLICT,
    message: 'This invite or request has already been answered.',
  },
  listing_team_not_accepted: {
    status: HttpStatus.CONFLICT,
    message: 'This persona is not on the team.',
  },
  listing_team_order_mismatch: {
    status: HttpStatus.CONFLICT,
    message:
      'The team changed while you were reordering. Reload and try again.',
  },
};

/** The one way the team routes refuse a request: `{ statusCode, code, message, ...details }`.
 *  The code, the status and the message always win over a detail of that name. */
export function listingTeamError(
  code: ListingTeamErrorCode,
  details: Record<string, unknown> = {},
): HttpException {
  const { status, message } = LISTING_TEAM_ERRORS[code];
  const body = { ...details, statusCode: status, code, message };
  if (status === HttpStatus.NOT_FOUND) {
    return new NotFoundException(body);
  }
  return new HttpException(body, status);
}
