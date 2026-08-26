import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { REASON_CODES, ReasonCode } from '../../reports/reason-catalogue';

/**
 * `PATCH /admin/members/:id/restriction` body — lift a scoped restriction
 * (`users.restricted` / `restricted_until`).
 *
 * Deliberately the same shape as {@link LiftSuspensionDto}: a lift is a
 * moderation decision like any other, so it cites a reason from the shared
 * taxonomy and carries the exact member-facing text the member reads. A
 * restriction is what a moderator reaches for INSTEAD of a suspension, and
 * until this endpoint existed the only way back out of one was winning an
 * appeal.
 */
export class LiftRestrictionDto {
  @IsIn(REASON_CODES)
  reasonCode!: ReasonCode;

  // The exact member-facing text — the reason the member reads in their
  // `moderation_outcome` notification.
  @IsString()
  @MaxLength(2000)
  note!: string;

  /**
   * The report this lift responds to, when there is one.
   *
   * Optional because a restriction can be lifted on its own merits (a mistake,
   * a member who has clearly moved on). Send it whenever one applies:
   * `GET /mod/reports/audit` filters by report, so a lift with no `reportId`
   * shows only in the global `GET /mod/audit` feed.
   */
  @IsOptional()
  @IsUUID('4')
  reportId?: string;
}
