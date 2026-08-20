import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  ResourceListingCategory,
  ResourceListingStatus,
} from '../entities/resource-listing.entity';
import { IsSafeExternalUrl } from '../../common/validators/is-safe-external-url.decorator';
import { HasAtLeastOneContactField } from './has-at-least-one-contact-field.validator';

export class CreateResourceListingDto {
  @IsEnum(ResourceListingCategory) category!: ResourceListingCategory;

  @HasAtLeastOneContactField()
  @IsString()
  @MaxLength(200)
  title!: string;

  @IsString() @MaxLength(2000) description!: string;

  @IsOptional() @IsString() @MaxLength(40) phone?: string;

  @IsOptional() @IsString() @MaxLength(320) email?: string;

  @IsOptional()
  @IsString()
  @IsSafeExternalUrl()
  @MaxLength(500)
  website?: string;

  @IsOptional() @IsString() @MaxLength(200) region?: string;

  @IsOptional() @IsEnum(ResourceListingStatus) status?: ResourceListingStatus;
}
