import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Query of the PUBLIC `GET /join-requests/status`. Unauthenticated, so the
 * token is attacker-controlled and is bounded before it ever reaches a query:
 * a charset constraint and a length cap turn every malformed guess into a 400
 * that costs no database round trip.
 *
 * The charset is base64url (`A-Z a-z 0-9 - _`), which is exactly what
 * `randomBytes(32).toString('base64url')` produces in
 * `JoinRequestsService.submit` — url-safe, so the token survives being pasted
 * into an address bar or a bookmark without escaping.
 *
 * The bounds are deliberately a RANGE rather than the token's exact 43
 * characters: a future rotation to a longer token must not make every
 * already-issued one fail validation instead of resolving. Anything outside
 * the range cannot be a token this service ever minted.
 */
export class JoinRequestStatusQuery {
  @IsString()
  @MinLength(32)
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: 'token must be a url-safe base64 string',
  })
  token!: string;
}
