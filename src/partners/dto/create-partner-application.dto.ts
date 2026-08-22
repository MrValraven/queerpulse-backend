import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IsSafeExternalUrl } from '../../common/validators/is-safe-external-url.decorator';
import { PartnerRegion } from '../entities/partner.entity';

export class PartnerStatDto {
  @IsString() @MinLength(1) @MaxLength(80) value!: string;
  @IsString() @MinLength(1) @MaxLength(80) label!: string;
}

export class PartnerSectionDto {
  @IsString() @MinLength(1) @MaxLength(200) heading!: string;
  @IsString() @MinLength(1) @MaxLength(5000) body!: string;
}

export class PartnerJointWorkDto {
  @IsString() @MinLength(1) @MaxLength(80) kicker!: string;
  @IsString() @MinLength(1) @MaxLength(200) title!: string;
  @IsString() @MinLength(1) @MaxLength(2000) dek!: string;
  @IsString() @MinLength(1) @MaxLength(200) footLeft!: string;
  @IsString() @MinLength(1) @MaxLength(200) footRight!: string;
}

export class PartnerTimelineItemDto {
  @IsString() @MinLength(1) @MaxLength(80) date!: string;
  @IsString() @MinLength(1) @MaxLength(200) title!: string;
  @IsString() @MinLength(1) @MaxLength(2000) body!: string;
}

export class PartnerAtGlanceDto {
  @IsString() @MinLength(1) @MaxLength(80) label!: string;
  @IsString() @MinLength(1) @MaxLength(200) value!: string;
}

export class PartnerContactDto {
  @IsOptional() @IsString() @MaxLength(50) phone?: string;
  @IsOptional() @IsString() @MaxLength(200) phoneNote?: string;
  // Reachable address or nothing: this is how the partnerships team replies to
  // an application. `''` is accepted because the form sends every contact field
  // whether or not it was filled in, matching `CreateListingDto`'s
  // `@ValidateIf`-on-non-empty precedent.
  @ValidateIf((dto: PartnerContactDto) => (dto.email ?? '') !== '')
  @IsEmail()
  @MaxLength(200)
  email?: string;
  @IsOptional()
  @IsString()
  @IsSafeExternalUrl()
  @MaxLength(300)
  website?: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string;
}

export class CreatePartnerApplicationDto {
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  /**
   * A short MONOGRAM shown on the partner card, not an image reference: every
   * real value in the codebase is two letters ("NA", "CH", "RA", "CS"), the
   * column is a plain `varchar`, and `toPartnerCard` emits it as text that the
   * card renders as a lettermark. It is deliberately NOT `@IsImageReference()`
   * for that reason: applying that decorator would reject every genuine value.
   *
   * The 500-char cap was nonetheless far wider than a lettermark needs, which
   * is what let an arbitrary blob sit in a field an admin reads in the pending
   * queue. Capped to a real monogram's length instead (BE-HSG-19). If partner
   * logos ever become actual uploaded images, that is a new column plus
   * `@IsImageReference()` plus a `toImageUrl()` pass in `toPartnerCard`, not a
   * widening of this one.
   */
  @IsString() @MinLength(1) @MaxLength(8) logo!: string;
  @IsEnum(PartnerRegion) region!: PartnerRegion;
  @IsString() @MinLength(1) @MaxLength(80) regionLabel!: string;
  @IsString() @MinLength(1) @MaxLength(200) city!: string;
  @IsString() @MinLength(1) @MaxLength(10000) desc!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  tags?: string[];

  @IsString() @MinLength(1) @MaxLength(80) tier!: string;
  @IsString() @MinLength(1) @MaxLength(80) since!: string;
  @IsString() @MinLength(1) @MaxLength(80) eyebrow!: string;
  @IsString() @MinLength(1) @MaxLength(200) tagline!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(2000, { each: true })
  about?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => PartnerStatDto)
  stats?: PartnerStatDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => PartnerSectionDto)
  aboutMore?: PartnerSectionDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => PartnerJointWorkDto)
  jointWork?: PartnerJointWorkDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => PartnerTimelineItemDto)
  timeline?: PartnerTimelineItemDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => PartnerSectionDto)
  how?: PartnerSectionDto[];

  @IsOptional() @IsString() @MaxLength(2000) funding?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => PartnerAtGlanceDto)
  atGlance?: PartnerAtGlanceDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => PartnerContactDto)
  contact?: PartnerContactDto;

  // Desired slug; `PartnersService.createWithUniqueSlug` slugifies + de-dupes
  // it, defaulting to `name` when omitted (mirrors `CreateCompanyDto.handle`).
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) handle?: string;
}
