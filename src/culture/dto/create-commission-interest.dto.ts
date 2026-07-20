import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { CommissionCategory } from '../entities/commission-interest.entity';

export class CreateCommissionInterestDto {
  @IsString() @MinLength(1) @MaxLength(500) commissionTitle: string;

  @IsEnum(CommissionCategory) commissionCategory: CommissionCategory;

  @IsString() @MinLength(1) @MaxLength(200) recipientName: string;

  @IsOptional() @IsString() @MaxLength(4000) message?: string;
}
