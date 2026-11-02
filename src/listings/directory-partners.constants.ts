import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';

/** The public directory shows at most this many partners in its top row. */
export const DIRECTORY_PARTNER_LIMIT = 12;

/** Longest partner note, counted in code points after trimming. */
export const DIRECTORY_PARTNER_NOTE_MAX = 140;

/** Most rows the admin picker search answers. */
export const DIRECTORY_PARTNER_SEARCH_LIMIT = 20;

/** Longest picker search text. The service cuts a longer `q` to this many
 *  characters, so the answer is always a list and the route has no generic 400. */
export const DIRECTORY_PARTNER_SEARCH_QUERY_MAX = 80;

/** The deferrable unique constraint on `directory_partner_picks.position`.
 *  A reorder or a remove rewrites positions under `SET CONSTRAINTS ... DEFERRED`. */
export const DIRECTORY_PARTNER_POSITION_CONSTRAINT =
  'UQ_directory_partner_picks_position';

/** Why a listing does or does not show in the public partner row. The first
 *  matching reason, in this order, wins. */
export type DirectoryPartnerPublicState =
  | 'showing'
  | 'not_live'
  | 'closed_for_good'
  | 'hidden_by_owner'
  | 'moderated'
  | 'adult_only';

export type DirectoryPartnerRefusalReason =
  | 'listing_not_found'
  | 'partner_not_found'
  | 'listing_not_live'
  | 'listing_adult_only'
  | 'already_partner'
  | 'partner_limit_reached'
  | 'note_too_long'
  | 'order_mismatch';

/** Status and message of every refusal the partner routes answer with. */
export const DIRECTORY_PARTNER_REFUSALS: Record<
  DirectoryPartnerRefusalReason,
  { status: HttpStatus; message: string }
> = {
  listing_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'No listing has this id.',
  },
  partner_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'This partner is no longer on the list.',
  },
  listing_not_live: {
    status: HttpStatus.CONFLICT,
    message:
      'This listing is not publicly listed in the directory, so it cannot be a partner.',
  },
  listing_adult_only: {
    status: HttpStatus.CONFLICT,
    message:
      'This listing is in the 18+ category, which the public directory leaves out, so it cannot be a partner.',
  },
  already_partner: {
    status: HttpStatus.CONFLICT,
    message: 'This listing is already a partner.',
  },
  partner_limit_reached: {
    status: HttpStatus.CONFLICT,
    message: `The partner list is full at ${DIRECTORY_PARTNER_LIMIT}. Remove a partner to add another.`,
  },
  note_too_long: {
    status: HttpStatus.BAD_REQUEST,
    message: `The note is longer than ${DIRECTORY_PARTNER_NOTE_MAX} characters.`,
  },
  order_mismatch: {
    status: HttpStatus.CONFLICT,
    message:
      'The partner list changed since it was loaded. Reload it and reorder again.',
  },
};

/** The one way the partner routes refuse a request:
 *  `{ statusCode, message, reason }`. The frontend maps `reason` to its copy. */
export function directoryPartnerError(
  reason: DirectoryPartnerRefusalReason,
): HttpException {
  const { status, message } = DIRECTORY_PARTNER_REFUSALS[reason];
  const body = { statusCode: status, message, reason };
  if (status === HttpStatus.NOT_FOUND) {
    return new NotFoundException(body);
  }
  if (status === HttpStatus.CONFLICT) {
    return new ConflictException(body);
  }
  return new BadRequestException(body);
}
