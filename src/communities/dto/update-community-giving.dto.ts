import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  MAX_GIVING_INTRO_LENGTH,
  MAX_GIVING_LABEL_LENGTH,
  MAX_GIVING_NOTE_LENGTH,
  MAX_GIVING_VALUE_LENGTH,
} from '../community-giving-rules';
import { CommunityGivingKind } from '../entities/community-giving-method.entity';

/**
 * One row of the giving section as the editor sends it. No `id` and no
 * `position`: array order becomes the position, and the global
 * `forbidNonWhitelisted` pipe refuses either key. The per-kind value rules
 * live in `normalizeGivingInput` so a refusal carries its own code and index.
 */
export class GivingMethodInputDto {
  @IsEnum(CommunityGivingKind)
  kind!: CommunityGivingKind;

  @IsString()
  @MaxLength(MAX_GIVING_VALUE_LENGTH)
  value!: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_GIVING_LABEL_LENGTH)
  label?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_GIVING_NOTE_LENGTH)
  note?: string | null;
}

/**
 * Body for `PUT /communities/:slug/giving`: the whole section, replacing what
 * is stored. `intro` must be present (null clears it): a missing key fails
 * `@IsString` because `ValidateIf` only skips an explicit null. The 8-method
 * cap lives in `normalizeGivingInput` so the refusal carries its own code.
 */
export class UpdateCommunityGivingDto {
  @ValidateIf((dto: UpdateCommunityGivingDto) => dto.intro !== null)
  @IsString()
  @MaxLength(MAX_GIVING_INTRO_LENGTH)
  intro!: string | null;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GivingMethodInputDto)
  methods!: GivingMethodInputDto[];
}
