import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsUUID,
  Min,
} from 'class-validator';

/** Entries one publish/dismiss/restore call may name. */
export const MAX_ENTRY_IDS_PER_CALL = 100;

// Body of `POST .../entries/dismiss` and `POST .../entries/restore`.
export class FeedEntryIdsDTO {
  @ApiProperty({
    type: [String],
    minItems: 1,
    maxItems: MAX_ENTRY_IDS_PER_CALL,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ENTRY_IDS_PER_CALL)
  @IsUUID('4', { each: true })
  entryIds!: string[];
}

// Body of `POST .../entries/publish`: an editor write, so it carries the
// same optional `expectedEditVersion` precondition a section save does.
export class PublishFeedEntriesDTO extends FeedEntryIdsDTO {
  @ApiPropertyOptional({
    description:
      'The editVersion the editor was built on. A stored editVersion that differs answers 409 { code: "PERSONA_EDIT_CONFLICT", currentEditVersion }. When omitted the publish is unconditional.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedEditVersion?: number;
}
