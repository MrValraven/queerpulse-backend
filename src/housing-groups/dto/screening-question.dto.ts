import { IsBoolean, IsString, MaxLength, MinLength } from 'class-validator';

export class ScreeningQuestionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  id!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(500)
  prompt!: string;

  @IsBoolean()
  required!: boolean;
}
