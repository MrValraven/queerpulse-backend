import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { StudioCopyrightClaimStatus } from '../entities/studio-copyright-claim.entity';
import { STUDIO_CLAIM_STATUSES } from '../studio-safety.constants';

/** `GET /admin/studio/copyright-claims` (Studio safety). */
export class ListAdminStudioClaimsQuery {
  /** Absent: the work queue (`submitted` and `countered` together). */
  @IsOptional()
  @IsIn(STUDIO_CLAIM_STATUSES)
  status?: StudioCopyrightClaimStatus;

  /** Opaque; a malformed value reads as the first page. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}
