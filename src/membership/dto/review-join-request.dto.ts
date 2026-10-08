import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PlatformJoinRequestStatus } from '../entities/join-request.entity';

export class ReviewJoinRequestDto {
  @IsIn([
    PlatformJoinRequestStatus.Approved,
    PlatformJoinRequestStatus.Declined,
    PlatformJoinRequestStatus.Waitlisted,
  ])
  status!:
    | PlatformJoinRequestStatus.Approved
    | PlatformJoinRequestStatus.Declined
    | PlatformJoinRequestStatus.Waitlisted;

  // Wired up fully in Task 2 (decline reason capture). Declared here so the
  // controller/service signature only changes once.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  declineReason?: string;

  // Closed-set key from the frontend catalogue, required by
  // `JoinRequestsService.review` when `status` is Approved.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  approvalReason?: string;

  // Staff-only free text, required by `JoinRequestsService.review` when the
  // approval reason is `other` and ignored (stored as NULL) otherwise.
  @IsOptional()
  @IsString()
  @MaxLength(500)
  approvalNote?: string;
}
