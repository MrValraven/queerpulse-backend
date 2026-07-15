import { IsString, MaxLength, MinLength } from 'class-validator';

// `POST /forum/threads` body — matches `CreateThreadDto` in the frontend's
// `forum.api.ts` exactly (`title`, `body`, `category`).
export class CreateThreadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title: string;

  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  body: string;

  @IsString()
  @MinLength(1)
  @MaxLength(50)
  category: string;
}
