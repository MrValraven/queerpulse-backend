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

  /**
   * OPS-04's "Assigned to me" filter, as a closed set rather than a user id.
   *
   * `me` resolves to the CALLER server-side and `unassigned` to a NULL
   * assignee. Deliberately not "any user id": the queue only ever needs
   * "mine" and "nobody's", and accepting an arbitrary id would turn a filter
   * into a way to enumerate what a named colleague is working on. Part of the
   * keyset, like every other narrowing here, so a cursor issued under one
   * value must not be reused under another.
   */
  @IsOptional()
  @IsIn(['me', 'unassigned'])
  assignedTo?: 'me' | 'unassigned';
}
