import { Transform, TransformFnParams } from 'class-transformer';
import {
  IsDateString,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { DESK_BODY_MAX, DESK_SHORT_TEXT_MAX } from './desk-text-limits';

/** Display numbers are stored zero-padded to two digits ("01".."14"), which
 *  is what makes the plain `ORDER BY number DESC` used across this module
 *  sort correctly on a varchar column. An editor typing "1" means issue 01,
 *  so normalize on the way in rather than rejecting them. Three-digit issues
 *  ("100") are left alone — padding only ever adds, never truncates. */
export function normalizeIssueNumber(rawNumber: string): string {
  return rawNumber.trim().padStart(2, '0');
}

/**
 * `POST /magazine/admin/issues` body: the smallest set of fields that
 * produces a valid, shippable `magazine_issue` row. `dek`, cover art, and
 * coverlines are deliberately absent — those are the issue-production
 * page's job (`UpdateCoverDto`), and duplicating them here would make the
 * create modal a second, competing editor for the same record.
 */
export class CreateIssueDto {
  /** Digits only. Normalized to at least two characters, so "1" becomes "01"
   *  and matches the numbers every existing issue and route already uses. */
  @IsString()
  @Transform(({ value }: TransformFnParams): unknown =>
    typeof value === 'string' ? normalizeIssueNumber(value) : value,
  )
  @Matches(/^\d{2,4}$/, {
    message: 'number must be digits only (for example "01" or "14")',
  })
  number!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(DESK_SHORT_TEXT_MAX)
  title!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(DESK_SHORT_TEXT_MAX)
  theme!: string;

  /** Postgres `date`. TypeORM reads this column back as a plain `YYYY-MM-DD`
   *  string, so it is stored and returned verbatim with no Date conversion.
   *  Both decorators are needed: `@Matches` pins the date-only shape the
   *  column stores (rejecting a full datetime), `@IsDateString` rejects a
   *  well-shaped but impossible date like "2026-13-45". */
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'publishedOn must be a YYYY-MM-DD date',
  })
  @IsDateString()
  publishedOn!: string;

  /** Optional at creation: the entity column is `text NOT NULL`, so an
   *  omitted dek is persisted as `''` rather than left null. */
  @IsOptional()
  @IsString()
  @MaxLength(DESK_BODY_MAX)
  dek?: string;
}
