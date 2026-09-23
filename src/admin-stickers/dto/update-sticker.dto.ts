import { Type } from 'class-transformer';
import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';
import { StickerKeywordsDto } from './create-sticker.dto';

/** New artwork for a sticker: the same fields and validators as
 *  `CreateStickerDto` minus `slug` and `sortOrder`, neither of which an
 *  artwork replacement changes. */
export class StickerArtworkDto {
  /** See `CreateStickerDto.storageKey` for what this validates and why the
   *  service re-checks it as a `sticker`-kind key the caller owns. */
  @IsImageReference()
  storageKey!: string;

  @IsInt() @Min(1) width!: number;
  @IsInt() @Min(1) height!: number;

  @IsString() @MinLength(1) @MaxLength(200000) svgSource!: string;

  @IsString() @MinLength(1) @MaxLength(64) templateId!: string;

  @IsObject() templateParams!: Record<string, unknown>;
}

/** Every field is optional, but the service rejects a body carrying none of
 *  them with 400: there is nothing to update. */
export class UpdateStickerDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) label?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => StickerKeywordsDto)
  keywords?: StickerKeywordsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => StickerArtworkDto)
  artwork?: StickerArtworkDto;
}
