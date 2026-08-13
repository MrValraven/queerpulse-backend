import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateRelocationRequestDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  /** The serious household conflict the member is flagging. */
  @IsString()
  @MinLength(10)
  @MaxLength(4000)
  situation!: string;
}
