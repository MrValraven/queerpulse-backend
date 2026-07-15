import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  DraftCategory,
  DraftKindVariant,
  DraftStatus,
} from '../entities/draft.entity';

export class CreateDraftDto {
  // Caller-supplied opaque id (see `Draft` entity doc) — not a uuid.
  @IsString() @MinLength(1) @MaxLength(200) id: string;

  @IsString() @MinLength(1) @MaxLength(50) kind: string;

  @IsEnum(DraftKindVariant) kindVariant: DraftKindVariant;

  @IsString() @MinLength(1) @MaxLength(500) title: string;

  @IsString() @MaxLength(4000) desc: string;

  @IsNumber() @Min(0) @Max(100) progress: number;

  @IsOptional() @IsBoolean() ready?: boolean;

  @IsOptional() @IsEnum(DraftCategory) category?: DraftCategory;

  @IsOptional() @IsEnum(DraftStatus) status?: DraftStatus;

  @IsOptional() @IsString() @MaxLength(2000) href?: string;

  @IsOptional() @IsInt() @Min(0) editedMinutes?: number;

  // `null` explicitly clears "no deadline"; `undefined` means "not sent".
  @IsOptional() @IsInt() deadlineDays?: number | null;

  @IsOptional() @IsString() @MaxLength(500) sortTitle?: string;

  @IsOptional() @IsString() @MaxLength(4000) searchText?: string;
}
