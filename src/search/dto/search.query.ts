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
  Business = 'business',
  Magazine = 'magazine',
  Job = 'job',
  Housing = 'housing',
  Resource = 'resource',
  Workshop = 'workshop',
  Subprofile = 'subprofile',
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
}
