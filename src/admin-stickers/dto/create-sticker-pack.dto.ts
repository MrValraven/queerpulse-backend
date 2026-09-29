import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateStickerPackDto {
  /** URL-safe and stable: it is what a later per-pack route would key on. */
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'slug must be lowercase words separated by single hyphens',
  })
  slug!: string;

  /** The English pack name. */
  @IsString() @MinLength(1) @MaxLength(80) name!: string;

  /** The Portuguese pack name. Optional: readers in Portuguese fall back to
   *  `name` while it is absent. */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) namePt?: string;

  @IsOptional() @IsString() @MaxLength(500) description?: string;
}
