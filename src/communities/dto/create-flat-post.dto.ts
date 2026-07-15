import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Body for `POST /community-posts` (the flat alias the feed uses — see
 * `CommunityPostsController`). `communitySlug` is optional: omit it for a
 * global post not scoped to any community. */
export class CreateFlatPostDto {
  @IsString() @MinLength(1) @MaxLength(5000) body: string;
  @IsOptional() @IsString() @MaxLength(200) communitySlug?: string;
}
