import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PostKind } from '../entities/community-post.entity';

export class UpdatePostDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(5000) body?: string;
  @IsOptional() @IsEnum(PostKind) kind?: PostKind;
  // Pinning is moderator-only; `CommunityPostsService.updatePost` enforces
  // that check, not this DTO.
  @IsOptional() @IsBoolean() pinned?: boolean;
}
