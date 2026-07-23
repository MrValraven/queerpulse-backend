import { IsString, MaxLength, MinLength } from 'class-validator';

// `PATCH /forum/threads/:slug` body — `editThreadTitle(slug, title)`.
export class UpdateThreadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title: string;
}
