import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Min } from 'class-validator';

/** Body of `POST :subprofileId/items/:itemId/revisions/:revisionId/restore`.
 * Every field is optional, so an empty or absent body restores as before. */
export class RestoreItemRevisionDTO {
  // ENG-451 save precondition, the same one the four editor writes carry.
  // When it differs from the stored `edit_version` the restore answers 409
  // `PERSONA_EDIT_CONFLICT` and changes nothing.
  @ApiPropertyOptional({
    type: Number,
    minimum: 0,
    description:
      'The editVersion this restore was built on. A stored editVersion that differs answers 409 { code: "PERSONA_EDIT_CONFLICT", currentEditVersion }. When omitted the restore is unconditional.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedEditVersion?: number;
}
