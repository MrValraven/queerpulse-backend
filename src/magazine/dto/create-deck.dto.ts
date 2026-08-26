import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';

/**
 * Body of `POST /magazine/admin/decks`. Metadata fields mirror
 * `MagazineDeck` (see `entities/magazine-deck.entity.ts`) — class-validator,
 * jobs-DTO style (`jobs/dto/create-job.dto.ts`). `slides` is
 * typed loosely as `unknown[]` here: the discriminated `DeckSlide` union
 * isn't expressible as class-validator decorators, so it's validated by hand
 * via `validateDeckSlides()` in `deck-slides.validation.ts`, called by the
 * service before `save()`.
 */
export class CreateDeckDto {
  // Kebab-case only — matches the frontend reader's slug routing.
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Matches(/^[a-z0-9-]+$/)
  slug!: string;

  @IsString() @MinLength(1) @MaxLength(200) title!: string;

  @IsOptional() @IsString() @MaxLength(200) kicker?: string;
  @IsOptional() @IsString() @MaxLength(200) section?: string;
  @IsOptional() @IsString() @MaxLength(200) byline?: string;
  @IsOptional() @IsString() @MaxLength(200) readTime?: string;
  // An uploaded storage key or an `https://` URL. Was `@IsString()` capped at
  // 200 — both too permissive (any scheme) and too tight (a real CDN URL with
  // query params overflows 200). `IsImageReference` fixes both.
  @IsOptional() @IsImageReference() cover?: string;
  @IsOptional() @IsString() @MaxLength(200) coverDesc?: string;

  @IsOptional() @IsString() @MaxLength(200) role?: string;

  @IsOptional() @IsString() @MaxLength(2000) authorBio?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  related?: string[];

  // Validated by hand via `validateDeckSlides()` in the service — see the
  // file-level comment above.
  @IsArray() @ArrayMaxSize(40) slides!: unknown[];
}
