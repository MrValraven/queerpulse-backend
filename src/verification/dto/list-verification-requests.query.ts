import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { VerificationType } from '../verification-level';
import { VerificationRequestStatus } from '../verification-request-status';
import {
  VERIFICATION_REQUEST_SORTS,
  VerificationRequestSort,
} from '../verification-response';

/**
 * `GET /admin/verifications/requests` query. Mirrors
 * `ListAdminVerificationsQuery`'s idiom: `q` is the free-text term matched
 * against the member's name/handle/email (server-side ILIKE); `sort` picks
 * the order (default `recent`, applied in the service); `cursor` is the
 * opaque keyset cursor returned as `nextCursor` on the previous page — omit
 * it for page one. Changing `status`/`type`/`q`/`sort` starts a new keyset,
 * so callers must NOT reuse a cursor issued under a different combination.
 */
export class ListVerificationRequestsQuery {
  @IsOptional()
  @IsIn(Object.values(VerificationRequestStatus))
  status?: VerificationRequestStatus;

  @IsOptional()
  @IsIn(Object.values(VerificationType))
  type?: VerificationType;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsIn(VERIFICATION_REQUEST_SORTS)
  sort?: VerificationRequestSort;

  @IsOptional()
  @IsString()
  cursor?: string;
}
