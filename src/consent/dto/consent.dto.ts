import { Type } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ConsentSource } from '../entities/consent-record.entity';

export class ConsentCategoriesDto {
  // `necessary` is always on; the client sends `true` and we require it.
  @Equals(true) necessary: true;
  @IsBoolean() analytics: boolean;
  @IsBoolean() monitoring: boolean;
}

export class ConsentDto {
  @IsOptional() @IsString() @MaxLength(200) anonId?: string;

  @ValidateNested()
  @Type(() => ConsentCategoriesDto)
  categories: ConsentCategoriesDto;

  @IsString() @MinLength(1) @MaxLength(50) policyVersion: string;

  @IsEnum(ConsentSource) source: ConsentSource;
}
