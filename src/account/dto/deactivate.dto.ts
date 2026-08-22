import { IsString, MaxLength, MinLength } from 'class-validator';

export class DeactivateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  reauthToken!: string;
}
