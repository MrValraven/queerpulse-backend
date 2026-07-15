import { PartialType } from '@nestjs/mapped-types';
import { CreateDraftDto } from './create-draft.dto';

// `id` is inherited (optional) so a stray value in the payload doesn't trip
// `forbidNonWhitelisted`, but `DraftsService.update` never reads it — the
// draft's id is fixed at creation and addressed via the `:id` route param
// (mirrors `UpdateCommunityDto`'s `handle` precedent).
export class UpdateDraftDto extends PartialType(CreateDraftDto) {}
