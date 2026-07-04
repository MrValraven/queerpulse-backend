import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { TitleKind } from '../entities/cinema-title.entity';

export class CreateTitleDto {
  @IsEnum(TitleKind)
  kind: TitleKind;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  // From the existing image upload flow (S3 presign) — not a Mux artifact.
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  coverImageUrl?: string;
}
