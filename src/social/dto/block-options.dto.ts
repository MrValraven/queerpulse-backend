import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ReportSubjectType } from '../../reports/entities/report.entity';
import { ReasonCode, reasonsFor } from '../../reports/reason-catalogue';

/**
 * The codes a `member` report offers, the only subject the companion report
 * is ever filed under (`SocialService.blockMember`). Read from the catalogue
 * so it follows every change there.
 */
const MEMBER_REASON_CODES: readonly ReasonCode[] = reasonsFor(
  ReportSubjectType.Member,
).map((option) => option.code);

/**
 * Optional body for `POST /blocks/:slug` (spec §3 Tier 1 "social";
 * `BlockOptions` in `social.api.ts`).
 */
export class BlockOptionsDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;

  // Drives the FE's "also report" affordance. When true, `blockMember` also
  // files a companion report against the blocked member via `ReportsService`
  // (subjectType `user`), using `reason` (or a default) as the report reason.
  @IsOptional()
  @IsBoolean()
  alsoReport?: boolean;

  /**
   * PRD-285. Why the companion report is being filed, when `alsoReport` is on.
   *
   * The block dialog's "also report" checkbox is the ONLY report path a member
   * profile offers, and until this field every report it produced was filed as
   * `other`. `other` derives the LOW severity band and a 7-day SLA
   * (`report-severity.ts`), so a member blocking someone for outing or doxxing
   * landed in the slowest queue and the emergency band never saw them. It also
   * meant the transparency report counted none of those filings under the
   * reason they actually happened for.
   *
   * Validated against the codes a `member` report offers, read from
   * `reason-catalogue.ts` so no hand-written copy here can drift from it
   * (ENG-488). `ReportsService.create` refuses a code the subject type does not
   * offer, and the companion report runs AFTER the block commits, so checking
   * here is what keeps a bad code from committing the block and then failing
   * its report. The member set also excludes the system-filed listing codes,
   * so a client cannot file one through this door.
   *
   * OPTIONAL, and omitting it keeps the old behaviour exactly: `blockMember`
   * falls back to `other`, so every existing caller (and any client that never
   * ships the new field) files precisely the report it filed before.
   */
  @IsOptional()
  @IsIn(MEMBER_REASON_CODES)
  reasonCode?: ReasonCode;
}
