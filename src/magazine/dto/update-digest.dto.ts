import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsOptional,
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

  /** CNT-6 "Schedule with issue" toggle — omitted leaves the issue's current
   *  `digestSendOnPublish` untouched, so a plain curation save never resets it. */
  @IsOptional()
  @IsBoolean()
  sendOnPublish?: boolean;
}
