import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

class AffiliationInputDTO {
  @IsString()
  @MaxLength(20)
  targetType!: string;

  @IsString()
  @MaxLength(200)
  targetSlug!: string;

  @IsString()
  @MaxLength(20)
  role!: string;
}

export class ReplaceAffiliationsDTO {
  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => AffiliationInputDTO)
  items!: AffiliationInputDTO[];
}
