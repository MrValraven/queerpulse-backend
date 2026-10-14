import { HttpException, HttpStatus } from '@nestjs/common';
import {
  STUDIO_ARTIST_PERSONA_KINDS,
  StudioArtistPersonaKind,
} from '../studio/studio.constants';

// Persona posts (Studio v3, phase F): the vocabularies of
// QUEERPULSE-STUDIO-V3-ARTIST-TOOLS-CONTRACT-2026-10-13.md, spelled as the
// frontend mirror spells them.

export const PERSONA_POST = {
  bodyMax: 500,
  linkMax: 1000,
  dailyLimit: 10,
  alertsPerDay: 3,
  pageSize: 10,
  excerptMax: 80,
} as const;

/** Studio artist kinds: every persona kind that publishes in Studio may post
 *  updates (`STUDIO_FORMAT_BY_KIND`). */
export const PERSONA_POST_KINDS: readonly StudioArtistPersonaKind[] =
  STUDIO_ARTIST_PERSONA_KINDS;
export type PersonaPostKind = StudioArtistPersonaKind;

export function isPersonaPostKind(kind: string): kind is PersonaPostKind {
  return (PERSONA_POST_KINDS as readonly string[]).includes(kind);
}

/** The rolling window behind the daily post limit and the alert throttle. */
export const PERSONA_POST_QUOTA_WINDOW_MILLISECONDS = 24 * 60 * 60 * 1000;

export const PERSONA_POST_REMOVAL_REASON_MAX = 500;

/** `mod_audit_logs.action` values the persona post staff route writes. */
export const PERSONA_POST_AUDIT_ACTIONS = {
  removed: 'persona_post_removed',
} as const;

export type PersonaPostErrorCode =
  | 'persona_posts_not_available'
  | 'persona_post_image_not_allowed'
  | 'persona_post_daily_limit';

const PERSONA_POST_ERRORS: Readonly<
  Record<PersonaPostErrorCode, { status: HttpStatus; message: string }>
> = {
  persona_posts_not_available: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'Updates are for personas that publish in Studio.',
  },
  persona_post_image_not_allowed: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'Add a photo uploaded for this persona.',
  },
  persona_post_daily_limit: {
    status: HttpStatus.TOO_MANY_REQUESTS,
    message: 'A persona can post 10 updates a day. Try again later.',
  },
};

export const PERSONA_POST_ERROR_CODES = Object.keys(
  PERSONA_POST_ERRORS,
) as PersonaPostErrorCode[];

/** The one way persona posts refuse a request: `{ statusCode, code, message }`. */
export function personaPostError(code: PersonaPostErrorCode): HttpException {
  const { status, message } = PERSONA_POST_ERRORS[code];
  return new HttpException({ statusCode: status, code, message }, status);
}

/**
 * The notification excerpt: whitespace collapsed, cut on the last space at
 * or before 80 characters (a hard cut at 80 when there is none), with an
 * ellipsis when anything was cut.
 */
export function personaPostExcerpt(body: string): string {
  const collapsed = body.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= PERSONA_POST.excerptMax) {
    return collapsed;
  }
  const window = collapsed.slice(0, PERSONA_POST.excerptMax + 1);
  const lastSpace = window.lastIndexOf(' ');
  const kept =
    lastSpace > 0
      ? window.slice(0, lastSpace)
      : collapsed.slice(0, PERSONA_POST.excerptMax);
  return `${kept.trimEnd()}…`;
}
