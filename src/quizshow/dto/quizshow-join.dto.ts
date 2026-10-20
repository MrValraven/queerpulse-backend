import { IsString, MaxLength } from 'class-validator';

/** `POST /quizshow/join` body. The service normalises the code. */
export class QuizshowJoinDto {
  @IsString()
  @MaxLength(20)
  code!: string;
}
