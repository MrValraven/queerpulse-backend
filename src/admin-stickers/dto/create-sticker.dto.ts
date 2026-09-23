import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';

export class StickerKeywordsDto {
  @IsArray()
  @ArrayMaxSize(24)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  en!: string[];

  @IsArray()
  @ArrayMaxSize(24)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  pt!: string[];
}

export class CreateStickerDto {
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'slug must be lowercase words separated by single hyphens',
  })
  slug!: string;

  @IsString() @MinLength(1) @MaxLength(80) label!: string;

  /** The bare storage key the builder's presigned PUT landed on. Validated as
   *  an uploaded image reference by `@IsImageReference` (the same decorator
   *  every other image slot in this codebase uses, matching
   *  `ForumPostPhotoDto.image`), with the global `StorageKeyOwnershipInterceptor`
   *  enforcing the caller uploaded it. Re-checked again in the service as a
   *  well-formed `sticker`-kind key specifically, since `@IsImageReference`
   *  accepts any of our upload kinds and the interceptor checks only ownership. */
  @IsImageReference()
  storageKey!: string;

  @IsInt() @Min(1) width!: number;
  @IsInt() @Min(1) height!: number;

  /** Standalone SVG markup, the re-editable source. Bounded generously: the
   *  Uno template produces roughly 2 KB, and a later template with more
   *  geometry should not need a schema change to fit. */
  @IsString() @MinLength(1) @MaxLength(200000) svgSource!: string;

  @IsString() @MinLength(1) @MaxLength(64) templateId!: string;

  @IsObject() templateParams!: Record<string, unknown>;

  @IsOptional()
  @ValidateNested()
  @Type(() => StickerKeywordsDto)
  keywords?: StickerKeywordsDto;

  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
}
