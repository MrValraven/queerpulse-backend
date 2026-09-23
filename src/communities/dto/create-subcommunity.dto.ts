import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';
import { AccessTier } from '../entities/community.entity';

/**
 * `POST /communities/:slug/subcommunities`. A space inherits its type, place,
 * languages and tags from the parent, so the body carries only what a space
 * decides for itself. `handle` becomes the slug through the same `slugify` and
 * de-dupe `CreateCommunityDto.handle` goes through. `rules` are the space's
 * own additions on top of the parent's rules, which it inherits.
 */
export class CreateSubcommunityDto {
  @IsString() @Length(1, 100) handle!: string;
  @IsString() @Length(1, 200) name!: string;
  @IsString() @Length(1, 200) tagline!: string;
  @IsString() @Length(1, 5000) purpose!: string;

  // Defaults to the parent's `whoFor` when omitted.
  @IsOptional() @IsString() @Length(1, 2000) whoFor?: string;

  @IsEnum(AccessTier) accessTier!: AccessTier;

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  rules!: string[];

  // Same convention as `CreateCommunityDto`: a storage key from the matching
  // upload kind or an absolute `https://` URL.
  @IsOptional() @IsImageReference() coverImageUrl?: string;
  @IsOptional() @IsImageReference() avatarImageUrl?: string;
}
