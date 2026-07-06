import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PostKind } from '../entities/community-post.entity';

export class CreatePostDto {
  @IsString() @MinLength(1) @MaxLength(5000) body: string;
  @IsOptional() @IsString() @MaxLength(2000) image?: string;
  @IsOptional() @IsEnum(PostKind) kind?: PostKind;
}
