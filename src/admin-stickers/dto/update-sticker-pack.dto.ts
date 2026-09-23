import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { StickerPackStatus } from '../../stickers/entities/sticker-pack.entity';

export class UpdateStickerPackDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;

  @IsOptional() @IsString() @MaxLength(500) description?: string;

  @IsOptional() @IsEnum(StickerPackStatus) status?: StickerPackStatus;

  @IsOptional() @IsInt() @Min(0) sortOrder?: number;

  @IsOptional() @IsUUID() coverStickerId?: string;
}
