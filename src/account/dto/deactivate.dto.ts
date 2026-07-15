import { IsString, MinLength } from 'class-validator';

export class DeactivateDto {
  @IsString()
  @MinLength(1)
  reauthToken: string;
}
