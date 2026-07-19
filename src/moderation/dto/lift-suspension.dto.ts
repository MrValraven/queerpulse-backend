import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { REASON_CODES, ReasonCode } from '../../reports/reason-catalogue';

// `PATCH /mod/users/:userId/suspension` body — lift a suspension or ban.
export class LiftSuspensionDto {
  @IsIn(REASON_CODES)
  reasonCode: ReasonCode;

  @IsString()
  @MaxLength(2000)
  note: string;

  /**
   * The report this lift responds to, when there is one.
   *
   * Optional because a suspension can be lifted on its own merits (a mistake, a
   * successful out-of-band appeal). But `GET /mod/reports/audit` filters by
   * report, and there is no global audit feed, so a lift with no `reportId`
   * is recorded and yet visible nowhere. Send it whenever one applies.
   */
  @IsOptional()
  @IsUUID('4')
  reportId?: string;
}
