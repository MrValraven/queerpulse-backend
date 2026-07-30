import { IsString, MaxLength, MinLength } from 'class-validator';

// Member `POST /roadmap/ideas` body — a plain-text feature idea, held as
// `pending` until an admin publishes or dismisses it.
export class SubmitIdeaDto {
  @IsString() @MinLength(3) @MaxLength(280)
  text: string;
}
