import { IsString } from 'class-validator';

export class CohostDto {
  @IsString()
  slug: string;
}
