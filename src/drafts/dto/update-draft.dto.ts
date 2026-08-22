import { PartialType } from '@nestjs/mapped-types';
import { IsInt, IsOptional, Min } from 'class-validator';
import { CreateDraftDto } from './create-draft.dto';

// `id` is inherited (optional) so a stray value in the payload doesn't trip
// `forbidNonWhitelisted`, but `DraftsService.update` never reads it — the
// draft's id is fixed at creation and addressed via the `:id` route param
// (mirrors `UpdateCommunityDto`'s `handle` precedent).
export class UpdateDraftDto extends PartialType(CreateDraftDto) {
  /**
   * The `version` the client last read (see `Draft.version`). When present, the
   * patch is refused with 409 unless the stored draft is still at that version,
   * so a second tab's autosave cannot silently discard this one's edits.
   *
   * Optional so an already-deployed client keeps saving while it is updated to
   * round-trip the field.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}
