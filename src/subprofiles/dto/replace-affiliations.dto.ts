import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  AFFILIATION_TARGET_TYPES,
  COMMUNITY_ROLES,
  EVENT_ROLES,
} from '../subprofile-validation';

// Field-level `@IsIn` rejects an entirely-unknown `targetType`/`role` as a 400
// on the field. The `role`-belongs-to-`targetType` pairing (an event role on a
// community affiliation, say) is a cross-field rule and stays in the service's
// `isValidAffiliation`, which this narrows rather than replaces.
const ALL_AFFILIATION_ROLES = [...EVENT_ROLES, ...COMMUNITY_ROLES];

class AffiliationInputDTO {
  @IsString()
  @MaxLength(20)
  @IsIn(AFFILIATION_TARGET_TYPES)
  targetType!: string;

  @IsString()
  @MaxLength(200)
  targetSlug!: string;

  @IsString()
  @MaxLength(20)
  @IsIn(ALL_AFFILIATION_ROLES)
  role!: string;
}

export class ReplaceAffiliationsDTO {
  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => AffiliationInputDTO)
  items!: AffiliationInputDTO[];

  // ENG-451 save precondition. When it differs from the stored `edit_version`
  // the PUT answers 409 `PERSONA_EDIT_CONFLICT` and changes nothing.
  @ApiPropertyOptional({
    type: Number,
    minimum: 0,
    description:
      'The editVersion this save was built on. A stored editVersion that differs answers 409 { code: "PERSONA_EDIT_CONFLICT", currentEditVersion }. When omitted the save is unconditional.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedEditVersion?: number;
}
