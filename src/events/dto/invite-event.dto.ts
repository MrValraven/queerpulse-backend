import { ArrayMaxSize, IsArray, IsString } from 'class-validator';

export class InviteEventDto {
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  slugs: string[];
}
