import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  Equals,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsSafeExternalUrl } from '../../common/validators/is-safe-external-url.decorator';
import { CreateCompanyDto } from '../../companies/dto/create-company.dto';
import { JobFormat } from '../entities/job.entity';
import { IsNotBelowRateMin } from './rate-range.validator';

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
  @IsString() @MinLength(1) @MaxLength(100) category!: string;
  @IsString() @MinLength(1) @MaxLength(100) commitment!: string;
  @IsString() @MinLength(1) @MaxLength(100) seniority!: string;
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
