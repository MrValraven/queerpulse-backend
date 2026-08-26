import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';
import {
  CARD_PHOTO_STYLES,
  CARD_TEXT_BACKDROPS,
  CardPhotoStyle,
  CardSkin,
  CardTextBackdrop,
} from '../entities/community-card.entity';

// The design tokens a community may choose as its card accent. A closed list
// because the card must stay inside the token system: a raw hex would break
// theming and could fail the contrast the skins guarantee.
// 'coral' is deliberately absent: there is no `--coral` design token (the
// coral colour is `--accent`), so an API-set 'coral' would break the card
// face's `color-mix()` and silently lose the accent tint.
const ACCENT_TOKENS = ['accent', 'plum', 'jade', 'ink'] as const;

// The curated card grounds. A closed list for the same reason ACCENT_TOKENS is
// one: the frontend owns how each is drawn (including the contrast scrim that
// keeps the card readable), so an unknown name here would render as nothing at
// all. Flags are rendered from these ids, never from colours a client posts.
const BACKGROUND_PRESETS = [
  'rainbow',
  'progress',
  'transgender',
  'bisexual',
  'lesbian',
  'pansexual',
  'asexual',
  'aromantic',
  'nonbinary',
  'genderfluid',
  'genderqueer',
  'agender',
  'intersex',
] as const;

export class UpsertCardProgramDto {
  @IsBoolean()
  isEnabled!: boolean;

  @IsEnum(CardSkin)
  skin!: CardSkin;

  @IsIn(ACCENT_TOKENS)
  accentToken!: string;

  // These two hold an upload key that other members' browsers fetch on every
  // card render, so they carry `@IsImageReference` like every other image
  // field. That decorator is also what the media-reference coverage tripwire
  // keys off, which is why both columns stayed invisible to the "in use"
  // resolver for as long as they did. `@MaxLength` stays alongside it: the
  // guard allows up to 2048 chars while `background_media_key` is
  // varchar(512).
  @IsOptional()
  @IsImageReference()
  @MaxLength(512)
  crestMediaKey?: string | null;

  // Null clears the preset. Absent leaves whatever is stored alone — see the
  // note on the crest in `CardProgramsService.upsert`.
  @IsOptional()
  @IsIn(BACKGROUND_PRESETS)
  backgroundPreset?: string | null;

  @IsOptional()
  @IsImageReference()
  @MaxLength(512)
  backgroundMediaKey?: string | null;

  @IsString()
  @MinLength(1)
  @MaxLength(32)
  cardName!: string;

  // 1 to 120 months, or null for a card that never expires.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  validityMonths?: number | null;

  @IsBoolean()
  allowsPublicBadge!: boolean;

  // Absent leaves the stored setting alone, matching the two switches below:
  // a client that predates printed cards cannot silently switch a community's
  // printing off on its next save.
  @IsOptional()
  @IsBoolean()
  allowsPrint?: boolean;

  // Absent leaves the stored setting alone, so a client that predates photo
  // cards cannot silently switch a community's photos off on its next save.
  @IsOptional()
  @IsBoolean()
  allowsMemberPhoto?: boolean;

  // Same absent-leaves-it-alone contract as the switch above.
  @IsOptional()
  @IsIn(CARD_PHOTO_STYLES)
  photoStyle?: CardPhotoStyle;

  // Whether these cards print each holder's pronouns beside their name. Same
  // absent-leaves-it-alone contract as the switches above.
  @IsOptional()
  @IsBoolean()
  allowsPronouns?: boolean;

  // Which legibility treatment a flag or photo ground carries. Same
  // absent-leaves-it-alone contract: a client that predates this setting must
  // not reset a community's chosen treatment on its next save.
  @IsOptional()
  @IsIn(CARD_TEXT_BACKDROPS)
  textBackdrop?: CardTextBackdrop;

  // Whether a holder may put their own card back in date near expiry, without
  // an owner running the roster bulk issue. Same absent-leaves-it-alone
  // contract as the switches above.
  @IsOptional()
  @IsBoolean()
  allowsSelfRenew?: boolean;
}
