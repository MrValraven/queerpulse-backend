import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { SavedKind } from '../entities/saved-item.entity';

/**
 * The mutable subset `PUT /me/saved/:id` accepts (frontend `SavedItemBody`
 * in `saved.api.ts`) — everything the client-side `SavedItem` carries except
 * `id` (in the URL) and the server-assigned `savedAt`.
 */
export class SavedItemBodyDto {
  @IsEnum(SavedKind)
  kind: SavedKind;

  @IsString()
  @IsNotEmpty()
  title: string;

  @IsOptional()
  @IsString()
  href?: string;

  @IsOptional()
  @IsString()
  meta?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  readTime?: string;
}
