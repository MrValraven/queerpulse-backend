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

/** The three moves a moderator can make on a request. Reused as a plain
 * string union rather than importing `VerificationRequestDecisionAction`
 * from `verification.service.ts` — same rationale as
 * `DecideVerificationRequestDto`'s own `DECISION_ACTIONS`: the two stay
 * structurally identical, but this DTO carries no dependency on the service
 * module. */
const BULK_DECISION_ACTIONS = ['in_review', 'approve', 'reject'] as const;
type BulkDecisionAction = (typeof BULK_DECISION_ACTIONS)[number];

/** Caps one bulk-decide call's batch size. `VerificationService.bulkDecide`
 * loops `decideRequest` once per id (no transaction spanning the whole
 * batch — each id is its own independent decision), so this bounds the
 * request's worst-case work and keeps a single call from reading as a
 * near-unbounded moderation action. Comfortably above any real triage-queue
 * multi-select. */
export const BULK_ACTION_CAP = 50;

/**
 * `POST /admin/verifications/requests/bulk` body — applies one decision to
 * many requests in a single call. `reason` is required only for
 * `action: 'reject'` (enforced service-side by `bulkDecide` — a single 400
 * for the whole call, thrown BEFORE any request in the batch is touched,
 * not a per-id failure: an empty-reason reject was never going to succeed
 * for any id).
 */
export class BulkDecideVerificationRequestsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_ACTION_CAP)
  @IsUUID('4', { each: true })
  ids!: string[];

  @IsIn(BULK_DECISION_ACTIONS)
  action!: BulkDecisionAction;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

/**
 * Response shape for the bulk endpoint — which ids succeeded and which
 * didn't. A per-id illegal transition, a missing request, or any other
 * error `decideRequest` throws for that one id lands in `failed` (carrying
 * that exception's own message) rather than aborting the rest of the batch;
 * only the up-front "reject needs a reason" check can fail the whole call.
 * Not a class-validator DTO (nothing to validate on a response) — kept
 * alongside the request DTO above since both describe the same bulk-action
 * surface, mirroring `BulkListingResultDTO` in
 * `src/listings/dto/bulk-listing.dto.ts`.
 */
export interface BulkDecideVerificationRequestsResultDTO {
  succeeded: string[];
  failed: { id: string; reason: string }[];
}
