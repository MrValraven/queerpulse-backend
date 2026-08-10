import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';

class DigestItemInput {
  @IsUUID()
  pieceId!: string;

  @IsString()
  blurb!: string;

  @IsBoolean()
  on!: boolean;
}

/**
 * `PATCH /magazine/admin/issues/:number/digest` body (Magazine Desk
 * Phase 5): replaces the members' digest/social curation wholesale.
 */
export class UpdateDigestDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DigestItemInput)
  items!: DigestItemInput[];
}
