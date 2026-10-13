import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ListStudioReleasesQuery {
  /** Opaque; a malformed value reads as the first page. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}
