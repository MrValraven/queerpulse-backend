import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  ADMIN_VERIFICATION_SORTS,
  AdminVerificationSort,
} from '../verification-response';
import { VerificationLevel } from '../verification-level';

/**
 * `GET /admin/verifications` query. `q` is the free-text term matched against
 * the member's name/handle/email (server-side ILIKE); `sort` picks the order
 * (default `recent`, applied in the service); `cursor` is the opaque keyset
 * cursor returned as `nextCursor` on the previous page — omit it for page one.
 * Changing `level`/`q`/`sort` starts a new keyset, so callers must NOT reuse a
 * cursor issued under a different filter/sort combination.
 */
export class ListAdminVerificationsQuery {
  @IsOptional()
  @IsIn(Object.values(VerificationLevel))
  level?: VerificationLevel;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsIn(ADMIN_VERIFICATION_SORTS)
  sort?: AdminVerificationSort;

  @IsOptional()
  @IsString()
  cursor?: string;
}
