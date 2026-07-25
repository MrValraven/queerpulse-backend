import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  VOUCH_RELATIONSHIPS,
  type VouchRelationship,
} from '../entities/vouch.entity';

export class CreateVouchDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @IsOptional()
  @IsIn(VOUCH_RELATIONSHIPS)
  relationship?: VouchRelationship;

  @IsOptional()
  @IsBoolean()
  anonymous?: boolean;
}
