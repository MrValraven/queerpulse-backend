import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';
import { SavedKind } from '../entities/saved-item.entity';

/** `GET /me/saved?kind=&page=` query params (`getSaved` in `saved.api.ts`). */
export class ListSavedQuery {
  @IsOptional()
  @IsEnum(SavedKind)
  kind?: SavedKind;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}
