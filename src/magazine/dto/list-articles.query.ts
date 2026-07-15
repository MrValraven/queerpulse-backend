import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class ListArticlesQuery {
  // Issue display number, e.g. "09" (matches `MagazineIssue.number`).
  @IsOptional()
  @IsString()
  issue?: string;

  @IsOptional()
  @IsString()
  tag?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}
