import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  DEFAULT_SUGGESTION_LIMIT,
  MAX_SUGGESTION_LIMIT,
} from '../member-suggestions.service';

/**
 * How many people the strip wants. There is no cursor and no page: a
 * suggestion surface that pages is a directory with extra steps, and the
 * directory already exists at `GET /members`.
 */
export class SuggestedMembersQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_SUGGESTION_LIMIT)
  limit?: number = DEFAULT_SUGGESTION_LIMIT;
}
