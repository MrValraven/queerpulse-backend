import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PartnerRegion } from '../entities/partner.entity';
import {
  PartnerAtGlanceDto,
  PartnerContactDto,
  PartnerJointWorkDto,
  PartnerSectionDto,
  PartnerStatDto,
  PartnerTimelineItemDto,
} from './create-partner-application.dto';

/**
 * The fields a partner may change about ITSELF, without re-review (PRD-263).
 *
 * Everything here is a fact the organisation owns and is the only reliable
 * source for: where it is, how to reach it, what it does, how it is funded.
 * Letting a stale phone number sit on a public page until an engineer edits
 * the row by hand is a worse failure than a partner mistyping its own address,
 * and none of these fields makes a claim about QueerPulse.
 *
 * Held OUT of this class on purpose, and reachable only through
 * `UpdatePartnerAdminDto`:
 *
 *  - `tier` and `since` describe THE RELATIONSHIP ("Founding partner", "with
 *    us since 2024"). A partner setting its own tier is a partner grading its
 *    own partnership.
 *  - `eyebrow` prints as "Partner · <type>" on the card, so its first word is
 *    also a relationship claim.
 *  - `name` is the identity the approval was granted to, and the slug (and
 *    therefore every inbound link) was allocated from it. A rename is a
 *    re-review, not an edit.
 *  - `featured` and the testimonial trio are QueerPulse's editorial voice on
 *    its own marketing page.
 *
 * Every field is optional: this is a PATCH and only what is sent changes. The
 * one exception to "only what is sent" is `contact`, which is REPLACED as a
 * whole block when present — the column is a single jsonb document that the
 * service always stores fully populated, so a partial contact would have to
 * mean "clear the rest", and the editor sends every subfield each time.
 */
export class UpdatePartnerProfileDto {
  @IsOptional() @IsEnum(PartnerRegion) region?: PartnerRegion;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  regionLabel?: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) city?: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(10000) desc?: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) tagline?: string;

  /**
   * A short MONOGRAM, not an image reference — see the long note on
   * `CreatePartnerApplicationDto.logo`. Same 8-character cap, for the same
   * reason: this is the two letters the card renders as a lettermark, and
   * `@IsImageReference()` would reject every genuine value.
   */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(8) logo?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  tags?: string[];

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
}
