import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class ListMembersQuery {
  @IsOptional() @IsString() query?: string;

  // comma-separated, e.g. ?tags=design,music
  @IsOptional() @IsString() tags?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
}
