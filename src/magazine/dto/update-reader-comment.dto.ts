import { IsString, MaxLength, MinLength } from 'class-validator';

// `PATCH /magazine/comments/:id` body — author-only body edit.
export class UpdateReaderCommentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  body!: string;
}
