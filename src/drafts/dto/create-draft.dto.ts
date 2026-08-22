import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
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
  @IsString() @MinLength(1) @MaxLength(200) id!: string;

  @IsString() @MinLength(1) @MaxLength(50) kind!: string;

  @IsEnum(DraftKindVariant) kindVariant!: DraftKindVariant;

  @IsString() @MinLength(1) @MaxLength(500) title!: string;

  @IsString() @MaxLength(4000) desc!: string;

  @IsNumber() @Min(0) @Max(100) progress!: number;

  @IsOptional() @IsBoolean() ready?: boolean;

  @IsOptional() @IsEnum(DraftCategory) category?: DraftCategory;

  @IsOptional() @IsEnum(DraftStatus) status?: DraftStatus;

  /**
   * Where the draft card's "Resume" navigates. Restricted to an APP-RELATIVE
   * path (CNT-15).
   *
   * This was `@IsString() @MaxLength(2000)`, so any scheme validated —
   * `javascript:`, `data:` — and `toDraftDTO` echoes the value back verbatim
   * into an `href` the client renders. Only the owner can read their own
   * drafts today, so that is self-XSS; the moment a draft is shared with a
   * collaborator or linked from a notification it becomes a stored-XSS and
   * open-redirect sink. Every value the frontend actually sends is a
   * `routeMap` path (`/work/jobs`, `/magazine/submit-story`, …), so nothing
   * legitimate is refused.
   *
   * The pattern also rejects a leading `//` and `/\`, which browsers resolve
   * as PROTOCOL-RELATIVE (`//evil.example` navigates off-site), and any
   * whitespace, which would let a scheme be smuggled past a naive prefix
   * check. An empty string is allowed: forms send `''` for an unset field and
   * `@IsOptional()` only skips `undefined`/`null`.
   */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Matches(/^(?:|\/(?![/\\])\S*)$/, {
    message: 'href must be an app-relative path starting with "/"',
  })
  href?: string;

  @IsOptional() @IsInt() @Min(0) editedMinutes?: number;

  // `null` explicitly clears "no deadline"; `undefined` means "not sent".
  @IsOptional() @IsInt() deadlineDays?: number | null;

  @IsOptional() @IsString() @MaxLength(500) sortTitle?: string;

  @IsOptional() @IsString() @MaxLength(4000) searchText?: string;
}
