import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { IsSafeExternalUrl } from '../../common/validators/is-safe-external-url.decorator';
import { MAX_GUIDE_SECTIONS } from '../guide-section';
import { GuideSectionDto } from './guide-section.dto';

/** Slugs are the guide's public address (`/resources/:slug` on the API), so
 *  they stay lowercase-kebab and are never derived from a title behind the
 *  editor's back. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class CreateResourceDto {
  @IsString()
  @MaxLength(120)
  @Matches(SLUG_PATTERN, {
    message: 'slug must be lowercase words separated by single hyphens',
  })
  slug!: string;

  @IsString() @MaxLength(60) category!: string;

  @IsString() @MaxLength(300) title!: string;

  @IsOptional() @IsString() @MaxLength(300) titlePt?: string;

  @IsString() @MaxLength(2000) description!: string;

  @IsOptional() @IsString() @MaxLength(2000) descriptionPt?: string;

  /** Card-footer chip, e.g. "Guide · 12 min". */
  @IsOptional() @IsString() @MaxLength(120) meta?: string;

  @IsOptional()
  @IsString()
  @IsSafeExternalUrl()
  @MaxLength(500)
  externalUrl?: string;

  /** The frontend path the guide is addressable at. Relative and rooted, so
   *  a guide can never be pointed at another origin. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^\/[A-Za-z0-9\-/]*$/, {
    message: 'routePath must be a site-relative path starting with "/"',
  })
  routePath?: string;

  /** Empty (or omitted) means the guide is metadata-only and the frontend
   *  keeps rendering its hardcoded page. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_GUIDE_SECTIONS)
  @ValidateNested({ each: true })
  @Type(() => GuideSectionDto)
  sections?: GuideSectionDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_GUIDE_SECTIONS)
  @ValidateNested({ each: true })
  @Type(() => GuideSectionDto)
  sectionsPt?: GuideSectionDto[];

  /** ISO date (YYYY-MM-DD). */
  @IsOptional() @IsDateString() lastReviewedOn?: string;

  @IsOptional() @IsString() @MaxLength(120) reviewedBy?: string;

  @IsOptional() @IsDateString() reviewDueOn?: string;

  /** Omit to leave the guide unpublished (a 404 on the public endpoints). */
  @IsOptional() @IsDateString() publishedAt?: string;
}
