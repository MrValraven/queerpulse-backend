import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  Min,
} from 'class-validator';
import {
  CommunityListFilter,
  CommunityListSort,
} from '../communities.service';
import { AccessTier, CommunityType } from '../entities/community.entity';

export class ListCommunitiesQuery {
  @IsOptional()
  @IsIn(['discover', 'mine'])
  filter?: CommunityListFilter;

  @IsOptional()
  @IsEnum(CommunityType)
  type?: CommunityType;

  @IsOptional()
  @IsEnum(AccessTier)
  access?: AccessTier;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  // Free-text search over name/tagline/purpose, ANDed with the filters above
  // (see `CommunitiesService.list`'s `q` handling) rather than replacing
  // them.
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  q?: string;

  // Defaults to 'newest' (current `created_at DESC` behavior) when omitted —
  // backward compatible with every existing caller. 'active' (most
  // members/most recent post activity) is intentionally not offered here;
  // see `CommunityListSort`'s comment in `communities.service.ts`.
  @IsOptional()
  @IsIn(['newest', 'name'])
  sort?: CommunityListSort;
}
