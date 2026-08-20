import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ResourceListingCategory } from '../entities/resource-listing.entity';
import { IsSafeExternalUrl } from '../../common/validators/is-safe-external-url.decorator';

export class CreateResourceSuggestionDto {
  @IsEnum(ResourceListingCategory) category!: ResourceListingCategory;

  @IsString() @MaxLength(200) name!: string;

  @IsString() @MaxLength(2000) description!: string;

  @IsOptional() @IsString() @MaxLength(40) phone?: string;

  @IsOptional() @IsString() @MaxLength(320) email?: string;

  @IsOptional()
  @IsString()
  @IsSafeExternalUrl()
  @MaxLength(500)
  website?: string;
}
