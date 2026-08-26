import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export enum SearchResultType {
  Member = 'member',
  Community = 'community',
  Event = 'event',
  Forum = 'forum',
  // Reply BODIES (SOC-08). Separate from `Forum`, which is thread titles: a
  // hit here links to the thread but is a different kind of answer, and the
  // two are ranked in separate queries so a title never competes with a body.
  ForumPost = 'forumPost',
  Business = 'business',
  Magazine = 'magazine',
  Job = 'job',
  Housing = 'housing',
  Resource = 'resource',
  Subprofile = 'subprofile',
  Topic = 'topic',
}

export class SearchQuery {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  q!: string;

  @IsOptional()
  @IsEnum(SearchResultType)
  type?: SearchResultType;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  /**
   * How many results of `type` to skip (SOC-08). Only meaningful with `type`
   * set: the unfiltered, all-types view caps every group at six and offers a
   * per-type tab instead of a deeper page. Capped at 200 because each type's
   * query pays for `offset + limit` rows, and a member scrolling 200 results
   * deep into one category needs a better query, not a longer list.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(200)
  offset?: number;
}
