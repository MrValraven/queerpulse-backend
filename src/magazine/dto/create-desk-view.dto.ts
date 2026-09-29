import { Transform, TransformFnParams } from 'class-transformer';
import { IsObject, IsString, MaxLength, MinLength } from 'class-validator';

/** A saved view's name is a short menu label. Matches the column length. */
export const DESK_VIEW_NAME_MAX = 60;

/** How many saved views one editor may keep. */
export const DESK_VIEWS_PER_OWNER_MAX = 20;

/** Trims a string body field before validation, so "  " fails `MinLength`. */
export const trimDeskViewName = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Body of `POST /magazine/admin/desk-views`. `query` is typed loosely here:
 * its shape is checked by hand in `validateDeskViewQuery()`
 * (`desk-view-query.validation.ts`), which the service calls before saving,
 * the same split `CreateDeckDto.slides` uses.
 */
export class CreateDeskViewDto {
  @Transform(trimDeskViewName)
  @IsString()
  @MinLength(1)
  @MaxLength(DESK_VIEW_NAME_MAX)
  name!: string;

  @IsObject() query!: Record<string, unknown>;
}
