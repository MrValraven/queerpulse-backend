import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { BoardResponseKind } from '../entities/board-post-response.entity';

export class RespondToBoardItemDto {
  @IsEnum(BoardResponseKind) kind!: BoardResponseKind;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  note?: string;
}
