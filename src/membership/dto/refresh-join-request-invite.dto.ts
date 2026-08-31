import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Body of the PUBLIC `POST /join-requests/status/invite/refresh`: the
 * applicant reviving their own lapsed approval invite (PRD-02).
 *
 * The token is the same credential `JoinRequestStatusQuery` guards, under the
 * same bounds and the same charset, and for the same reason: this route is
 * unauthenticated, so the value is attacker-controlled and every malformed
 * guess must become a 400 before it costs a database round trip.
 *
 * It rides in the BODY rather than the query string because this one is a
 * state-changing request, and a credential in a query string on a POST would
 * be written into access logs and the browser's history for a call that
 * changes something. The read route keeps its query parameter, since that URL
 * is the applicant's own bookmark by design.
 */
export class RefreshJoinRequestInviteDto {
  @IsString()
  @MinLength(32)
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: 'token must be a url-safe base64 string',
  })
  token!: string;
}
