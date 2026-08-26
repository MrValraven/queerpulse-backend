import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  GUIDE_BLOCK_KINDS,
  GuideBlockKind,
  MAX_GUIDE_BLOCKS_PER_SECTION,
  MAX_GUIDE_BLOCK_LENGTH,
} from '../guide-section';

/** One block inside a section. Plain text only: the renderer prints it as
 *  text, so there is no markup to sanitize and no way for an editor to
 *  accidentally break a page's layout. */
export class GuideBlockDto {
  @IsIn(GUIDE_BLOCK_KINDS) kind!: GuideBlockKind;

  @IsString() @MaxLength(MAX_GUIDE_BLOCK_LENGTH) text!: string;
}

export class GuideSectionDto {
  /** Anchor id, unique within the guide. */
  @IsString() @MaxLength(80) id!: string;

  /** H2 for the section. May be empty for an unheaded lead section. */
  @IsString() @MaxLength(300) heading!: string;

  @IsArray()
  @ArrayMaxSize(MAX_GUIDE_BLOCKS_PER_SECTION)
  @ValidateNested({ each: true })
  @Type(() => GuideBlockDto)
  blocks!: GuideBlockDto[];
}
