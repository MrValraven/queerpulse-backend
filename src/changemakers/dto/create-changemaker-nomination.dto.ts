import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateChangemakerNominationDto {
  @IsString() @MinLength(1) @MaxLength(200) nomineeName: string;
}
