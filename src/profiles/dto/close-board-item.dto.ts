import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CloseBoardItemDto {
  @IsOptional()
  @IsString()
  @MaxLength(140)
  note?: string;
}
