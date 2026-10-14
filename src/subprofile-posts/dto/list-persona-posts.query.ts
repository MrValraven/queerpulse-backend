import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ListPersonaPostsQuery {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}
