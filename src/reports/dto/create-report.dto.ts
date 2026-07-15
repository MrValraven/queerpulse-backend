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
  type: 'url' | 'screenshot';

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
  subjectType: ReportSubjectType;

  // slug/uuid for member/community, content id for post/reply/message, safe-
  // space id for venue.
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  subjectId: string;

  @IsIn(REASON_CODES)
  reasonCode: ReasonCode;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  detail?: string;

  // Shields the reporter's identity from mods + the reported party.
  @IsOptional()
  @IsBoolean()
  anonymous?: boolean;

  // Only for anonymous follow-up when the reporter has no account.
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
