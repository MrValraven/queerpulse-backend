import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

// `GET /magazine/articles/:slug/comments?page=` query.
export class ListReaderCommentsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}
