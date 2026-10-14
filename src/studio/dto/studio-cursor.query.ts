import { IsOptional, IsString, MaxLength } from 'class-validator';

/** A keyset page request. Opaque; a malformed value reads as the first page. */
export class StudioCursorQuery {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}
