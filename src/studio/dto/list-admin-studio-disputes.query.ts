import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { StudioReleaseDisputeStatus } from '../entities/studio-release-dispute.entity';
import { STUDIO_DISPUTE_STATUSES } from '../studio.constants';

/** `GET /admin/studio/disputes` (Studio open demo pages). */
export class ListAdminStudioDisputesQuery {
  /** Defaults to `open`, the Disputes tab. */
  @IsOptional()
  @IsIn(STUDIO_DISPUTE_STATUSES)
  status?: StudioReleaseDisputeStatus;

  /** Opaque; a malformed value reads as the first page. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}
