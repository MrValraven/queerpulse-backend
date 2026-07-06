import { Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsOptional, Min } from 'class-validator';
import { CommunityListFilter } from '../communities.service';
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
}
