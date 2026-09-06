import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ReportSubjectType } from '../entities/report.entity';
import { REASON_CODES, ReasonCode } from '../reason-catalogue';

// One item of `CreateReportInput['evidence']` — a discriminated union in the
// frontend (`{type:'url',value} | {type:'screenshot',uploadId}`); modeled here
// as one class with the non-matching field left undefined per `type` so
// `whitelist` doesn't reject either shape.
export class ReportEvidenceDto {
  @IsIn(['url', 'screenshot'])
  type!: 'url' | 'screenshot';

  @ValidateIf((o: ReportEvidenceDto) => o.type === 'url')
  @IsString()
  @MaxLength(2000)
  value?: string;

  @ValidateIf((o: ReportEvidenceDto) => o.type === 'screenshot')
  @IsString()
  @MaxLength(200)
  uploadId?: string;
}

// `POST /reports` body — matches `CreateReportInput` in
// `queerpulse/src/features/safety/api/reports.api.ts` exactly (see
// `.superpowers/sdd/connect-FINAL-review.md` C2/I5).
export class CreateReportDto {
  @IsIn(Object.values(ReportSubjectType))
  subjectType!: ReportSubjectType;

  // slug/uuid for member/community, content id for post/reply/message, safe-
  // space id for venue.
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  subjectId!: string;

  @IsIn(REASON_CODES)
  reasonCode!: ReasonCode;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  detail?: string;

  // Shields the reporter's identity from mods + the reported party.
  @IsOptional()
  @IsBoolean()
  anonymous?: boolean;

  // An off-platform address a SIGNED-OUT reporter may leave so a human on the
  // safety team can choose to reach out by hand. Nothing sends to it:
  // QueerPulse delivers no email.
  //
  // Accepted from anyone and PERSISTED ONLY when there is no account behind
  // the report. `ReportsService.create` drops it on a signed-in filing rather
  // than refusing one, because a member is already reachable through the
  // notification bell and can read their own report's status on
  // `GET /reports/mine`, so storing an address beside their id buys nothing
  // and leaves a second copy of their personal data on a moderation row. The
  // frontend hides the field for signed-in members; the server is what makes
  // that a rule instead of a display choice. See `Report.contactEmail`.
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  contactEmail?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ReportEvidenceDto)
  evidence?: ReportEvidenceDto[];
}
