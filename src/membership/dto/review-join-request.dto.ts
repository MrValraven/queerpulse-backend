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
}
