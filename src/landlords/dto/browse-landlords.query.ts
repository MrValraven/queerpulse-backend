import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class BrowseLandlordsQuery {
  @IsOptional() @IsString() @MaxLength(160) hood?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
}
