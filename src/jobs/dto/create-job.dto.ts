import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  Equals,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IsSafeExternalUrl } from '../../common/validators/is-safe-external-url.decorator';
import { CreateCompanyDto } from '../../companies/dto/create-company.dto';
import {
  DISCIPLINE_BY_PROFESSION,
  JOB_FIELD_IDS,
} from '../../profiles/professions';
import { JobFormat } from '../entities/job.entity';
import { JOB_COMMITMENT_IDS, JOB_SENIORITY_IDS } from '../job-vocabulary';
import { IsNotBelowRateMin } from './rate-range.validator';

// Every known profession id. Whether it sits inside the job's chosen field is
// checked in `JobsService`, since that needs both values at once.
const ALL_PROFESSION_IDS = Object.keys(DISCIPLINE_BY_PROFESSION);

// A ceiling, not a policy: high enough for an annual salary in any currency the
// board realistically carries, low enough that a typo cannot produce scientific
// notation on a job card.
const MAX_JOB_RATE = 100_000_000;

export class JobDetailBodyDto {
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(2000, { each: true })
  about!: string[];

  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(2000, { each: true })
  dayToDay!: string[];

  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(2000, { each: true })
  lookingFor!: string[];

  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(2000, { each: true })
  offer!: string[];

  @IsOptional() @IsString() @MaxLength(2000) reviewerNote?: string | null;
}

export class CreateJobDto {
  @IsString() @MinLength(1) @MaxLength(200) title!: string;
  // A job field id from `JOB_FIELD_IDS` (profile-only and unlisted fields are
  // left out of that list, so they 400 here).
  @IsString() @IsIn(JOB_FIELD_IDS) category!: string;
  // Optional profession id inside `category`. `null` clears it on update
  // (`UpdateJobDto` inherits these decorators through `PartialType`).
  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  @IsString()
  @IsIn(ALL_PROFESSION_IDS)
  profession?: string | null;
  @IsString() @IsIn(JOB_COMMITMENT_IDS) commitment!: string;
  @IsString() @IsIn(JOB_SENIORITY_IDS) seniority!: string;
  @IsEnum(JobFormat) format!: JobFormat;
  @IsString() @MinLength(1) @MaxLength(200) location!: string;
  @IsOptional() @IsString() @MaxLength(200) city?: string;
  @IsOptional() @IsString() @MaxLength(100) timezone?: string;

  // -> `Job.desc` (card blurb).
  @IsString() @MinLength(1) @MaxLength(10000) description!: string;

  @IsOptional() @IsString() @MaxLength(100) deadline?: string;
  @IsOptional() @IsString() @MaxLength(100) startDate?: string;

  @IsOptional() @IsString() @MaxLength(200) salary?: string;

  // Money, in whole currency units with at most cents of precision. Previously
  // a bare `@IsNumber() @Min(0)`, which accepted `1.005` (renders as either
  // "1.00" or "1.01" depending on the formatter) and `1e21` (renders as
  // "1e+21"). The `numeric` column is exact decimal, so bounding the input is
  // all that is needed to keep pay readable.
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_JOB_RATE)
  rateMin?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_JOB_RATE)
  @IsNotBelowRateMin()
  rateMax?: number;

  // NOTE: still a free string because the "Post a job" form sends a currency
  // SYMBOL (`€`/`£`/`$`, `CURRENCIES` in the frontend's `postJob.data.ts`), not
  // an ISO 4217 code. Tightening this to `@Length(3, 3)` uppercase requires the
  // form to send codes first, otherwise every job post 400s.
  @IsOptional() @IsString() @MaxLength(10) currency?: string;
  @IsOptional() @IsString() @MaxLength(50) ratePer?: string;
  @IsOptional() @IsBoolean() hidePay?: boolean;
  @IsOptional() @IsBoolean() barter?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  benefits?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  inclusivity?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  tags?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  screening?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  contacts?: string[];

  @IsOptional() @IsEmail() email?: string;

  @IsOptional()
  @IsString()
  @IsSafeExternalUrl()
  @MaxLength(500)
  link?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => JobDetailBodyDto)
  detail?: JobDetailBodyDto;

  @IsOptional() @IsBoolean() queerRun?: boolean;
  @IsOptional() @IsString() @MaxLength(120) qrLabel?: string;

  // Existing company (poster must own it or be on its team) — mutually
  // exclusive with `company` (inline-create when this is omitted).
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) companySlug?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => CreateCompanyDto)
  company?: CreateCompanyDto;

  // Must be `true` — this is a consent gate the service never re-reads (see
  // `CreateJobInput` in `jobs.service.ts`).
  @IsBoolean()
  @Equals(true, { message: 'You must agree to the posting terms' })
  agreement!: boolean;
}
