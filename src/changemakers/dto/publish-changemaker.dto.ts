import { IsBoolean } from 'class-validator';

export class PublishChangemakerDto {
  @IsBoolean() published: boolean;
}
