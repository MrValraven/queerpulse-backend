import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { DsarStatus } from '../../account/entities/dsar-request.entity';

/** The statuses an operator can move a DSAR INTO. `received` is the intake
 *  state `POST /account/dsar` writes; nothing moves a request back to it. */
export const ADMIN_DSAR_TARGET_STATUSES = [
  DsarStatus.InReview,
  DsarStatus.Resolved,
  DsarStatus.Rejected,
] as const;

export type AdminDsarTargetStatus = (typeof ADMIN_DSAR_TARGET_STATUSES)[number];

export class UpdateAdminDsarDto {
  @IsIn(ADMIN_DSAR_TARGET_STATUSES)
  status!: AdminDsarTargetStatus;

  /**
   * The operator-authored outcome: what was done about the request, in their
   * own words. REQUIRED when moving to `resolved`/`rejected` (enforced in the
   * service, which is the only place that knows the target status is
   * terminal), optional on the move to `in_review` where there is nothing to
   * report yet. Capped at the same 4 KB `SubmitDsarDto.details` allows, so an
   * answer can be as long as the question.
   */
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  outcomeNote?: string;
}
