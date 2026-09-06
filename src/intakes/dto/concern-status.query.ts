import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Query of the PUBLIC `GET /intakes/concerns/status` (PRD-261). Unauthenticated,
 * so the code is attacker-controlled and is bounded before it ever reaches a
 * query: a charset constraint and a length cap turn every malformed guess into
 * a 400 that costs no database round trip.
 *
 * Copied field-for-field from `JoinRequestStatusQuery`, which guards the other
 * public token lookup on this platform, so the two routes cannot drift into
 * different ideas of what a reference code looks like.
 *
 * The charset is base64url (`A-Z a-z 0-9 - _`), which is exactly what
 * `randomBytes(32).toString('base64url')` produces in `IntakesService.submit` —
 * url-safe, so the code survives being pasted into an address bar or a bookmark
 * without escaping.
 *
 * The bounds are deliberately a RANGE rather than the code's exact 43
 * characters: a future rotation to a longer code must not make every
 * already-issued one fail validation instead of resolving. Anything outside the
 * range cannot be a code this service ever minted.
 */
export class ConcernStatusQuery {
  @IsString()
  @MinLength(32)
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: 'token must be a url-safe base64 string',
  })
  token!: string;
}
