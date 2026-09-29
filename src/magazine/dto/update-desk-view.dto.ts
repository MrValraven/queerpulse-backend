import { Transform } from 'class-transformer';
import {
  IsInt,
  IsObject,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  DESK_VIEW_NAME_MAX,
  DESK_VIEWS_PER_OWNER_MAX,
  trimDeskViewName,
} from './create-desk-view.dto';

/**
 * Body of `PATCH /magazine/admin/desk-views/:id`: rename, move, or replace
 * the stored query. Every field is optional and an omitted one is left
 * alone. `position` is the view's new zero-based index in its owner's list;
 * the service shifts the others to make space.
 *
 * Each field is validated whenever the key is present. `@IsOptional()` would
 * also let an explicit `null` through, and a null name or position has no
 * meaning here, so `{ "name": null }` answers 400 like any other bad value.
 */
export class UpdateDeskViewDto {
  @ValidateIf((dto: UpdateDeskViewDto) => dto.name !== undefined)
  @Transform(trimDeskViewName)
  @IsString()
  @MinLength(1)
  @MaxLength(DESK_VIEW_NAME_MAX)
  name?: string;

  @ValidateIf((dto: UpdateDeskViewDto) => dto.position !== undefined)
  @IsInt()
  @Min(0)
  @Max(DESK_VIEWS_PER_OWNER_MAX - 1)
  position?: number;

  @ValidateIf((dto: UpdateDeskViewDto) => dto.query !== undefined)
  @IsObject()
  query?: Record<string, unknown>;
}
