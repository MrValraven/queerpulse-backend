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
import { CardSkin } from '../entities/community-card.entity';

// The design tokens a community may choose as its card accent. A closed list
// because the card must stay inside the token system: a raw hex would break
// theming and could fail the contrast the skins guarantee.
// 'coral' is deliberately absent: there is no `--coral` design token (the
// coral colour is `--accent`), so an API-set 'coral' would break the card
// face's `color-mix()` and silently lose the accent tint.
const ACCENT_TOKENS = ['accent', 'plum', 'jade', 'ink'] as const;

export class UpsertCardProgramDto {
  @IsBoolean()
  isEnabled!: boolean;

  @IsEnum(CardSkin)
  skin!: CardSkin;

  @IsIn(ACCENT_TOKENS)
  accentToken!: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  crestMediaKey?: string | null;

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
}
