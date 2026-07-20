import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';
import { PostKind } from '../entities/community-post.entity';

export class CreatePostDto {
  @IsString() @MinLength(1) @MaxLength(5000) body: string;
  @IsOptional() @IsImageReference() image?: string;
  @IsOptional() @IsEnum(PostKind) kind?: PostKind;
}
