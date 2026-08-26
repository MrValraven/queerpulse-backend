import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body for `POST /events/:slug/check-ins` — host and co-host only.
 *
 * Exactly ONE of `memberSlug` or `cardToken` is required, and the service
 * rejects a body carrying both or neither. Two ways in, one record:
 *  - `memberSlug`: the host taps a name on their own attendee list.
 *  - `cardToken`: the host scans the QR on the member's membership card. The
 *    string is the card's own permanent code (`CardTokenService`), the same
 *    one `GET /cards/verify/:token` resolves, so the door reuses the
 *    credential the platform already issues instead of minting a second one.
 */
export class CheckInDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  memberSlug?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  // An Ed25519 envelope is ~110 characters; the cap is generous slack, not a
  // format claim. `CardTokenService.verify` is the only thing that decides
  // whether the string is a token, and it never throws.
  @MaxLength(500)
  cardToken?: string;
}
