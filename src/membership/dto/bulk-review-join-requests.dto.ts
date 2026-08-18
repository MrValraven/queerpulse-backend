import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PlatformJoinRequestStatus } from '../entities/join-request.entity';

/** Caps one bulk-review call's batch size. `JoinRequestsService.bulkReview`
 * loops `review` once per id (no transaction spanning the whole batch — each
 * id is its own independent, conditionally-claimed review), so this bounds
 * the request's worst-case work and keeps a single call from reading as a
 * near-unbounded moderation action. Mirrors `BULK_ACTION_CAP` on
 * `BulkDecideVerificationRequestsDto`. */
export const JOIN_REQUEST_BULK_ACTION_CAP = 50;

/**
 * `POST /join-requests/bulk` body — applies one review decision (approve,
 * decline, or waitlist) to many join requests in a single call. `declineReason`
 * is only meaningful for `status: Declined`; `JoinRequestsService.review`
 * (called once per id) enforces that requirement per-id, so an empty reason on
 * a bulk decline lands every id in `failed`, not a single up-front 400.
 */
export class BulkReviewJoinRequestsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(JOIN_REQUEST_BULK_ACTION_CAP)
  @IsUUID('4', { each: true })
  ids!: string[];

  @IsIn([
    PlatformJoinRequestStatus.Approved,
    PlatformJoinRequestStatus.Declined,
    PlatformJoinRequestStatus.Waitlisted,
  ])
  status!:
    | PlatformJoinRequestStatus.Approved
    | PlatformJoinRequestStatus.Declined
    | PlatformJoinRequestStatus.Waitlisted;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  declineReason?: string;
}
