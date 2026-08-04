import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Body of `POST /magazine/admin/decks`. Metadata fields mirror
 * `MagazineDeck` (see `entities/magazine-deck.entity.ts`) — class-validator,
 * workshops-DTO style (`workshops/dto/create-workshop.dto.ts`). `slides` is
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
  @IsOptional() @IsString() @MaxLength(200) cover?: string;
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
