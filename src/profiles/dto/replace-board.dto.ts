import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
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

  // The vocabulary itself stays curated in the frontend
  // (src/features/members/profileTags.data.ts) and is matched literally here,
  // exactly how profile tags already behave. This validates shape and size.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  tags?: string[];
}

export class ReplaceBoardDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => BoardItemDto)
  items!: BoardItemDto[];
}
