import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/** The three moves a moderator can make on a request. Kept as a plain string
 * union rather than importing `VerificationRequestDecisionAction` from
 * `verification.service.ts` — the two stay structurally identical, but this
 * DTO carries no dependency on the service module. */
const DECISION_ACTIONS = ['in_review', 'approve', 'reject'] as const;
type DecisionAction = (typeof DECISION_ACTIONS)[number];

/**
 * `PATCH /admin/verifications/requests/:id` body. `reason` is required only
 * for `action: 'reject'` (enforced service-side by `decideRequest` — 400
 * without one); optional here so `in_review`/`approve` can omit it.
 */
export class DecideVerificationRequestDto {
  @IsIn(DECISION_ACTIONS)
  action!: DecisionAction;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}
