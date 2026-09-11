import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  GUIDE_BLOCK_KINDS,
  GuideBlockKind,
  MAX_GUIDE_BLOCKS_PER_SECTION,
  MAX_GUIDE_BLOCK_HTML_LENGTH,
  MAX_GUIDE_BLOCK_LENGTH,
} from '../guide-section';

/** One block inside a section. `text` is plain; `html` is optional inline rich text that the service sanitizes and turns into `text`. */
export class GuideBlockDto {
  @IsIn(GUIDE_BLOCK_KINDS) kind!: GuideBlockKind;

  @IsString() @MaxLength(MAX_GUIDE_BLOCK_LENGTH) text!: string;

  /** Inline rich text for paragraph, list item and note blocks. Ignored on
   *  subheadings. */
  @IsOptional()
  @IsString()
  @MaxLength(MAX_GUIDE_BLOCK_HTML_LENGTH)
  html?: string;
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
