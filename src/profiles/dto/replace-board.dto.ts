import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { BoardKind } from '../entities/board-post.entity';

export class BoardItemDto {
  @IsEnum(BoardKind) kind!: BoardKind;
  @IsString() @MinLength(1) @MaxLength(120) title!: string;
  @IsString() @MinLength(1) @MaxLength(120) slug!: string;
}

export class ReplaceBoardDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => BoardItemDto)
  items!: BoardItemDto[];
}
