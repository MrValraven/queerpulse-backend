import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';
import { PostKind } from '../entities/community-post.entity';

export class UpdatePostDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(5000) body?: string;
  @IsOptional() @IsEnum(PostKind) kind?: PostKind;
  // Author-only, like `body` — `CommunityPostsService.updatePost` enforces the
  // author check and deletes the superseded object on replace/clear. `@IsOptional`
  // treats `null`/`''` as "skip", so both clear the image back to none.
  @IsOptional() @IsImageReference() image?: string | null;
  // Pinning is moderator-only; `CommunityPostsService.updatePost` enforces
  // that check, not this DTO.
  @IsOptional() @IsBoolean() pinned?: boolean;
}
