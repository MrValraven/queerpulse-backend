import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
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

  // The ways the voucher knows the member — one or more. Optional at the wire
  // level (kept lenient for compatibility), but when present it must be a
  // non-empty array of known relationship values, bounded by the enum size.
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(VOUCH_RELATIONSHIPS.length)
  @IsIn(VOUCH_RELATIONSHIPS, { each: true })
  relationships?: VouchRelationship[];

  @IsOptional()
  @IsBoolean()
  anonymous?: boolean;
}
