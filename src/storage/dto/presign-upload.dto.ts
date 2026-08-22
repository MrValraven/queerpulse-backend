import { IsIn, IsInt, Min } from 'class-validator';
import { ALLOWED_IMAGE_TYPES } from '../upload-content-types';

// Body for the legacy per-surface `/uploads/avatar` and `/uploads/work-image`
// routes. `byteSize` mirrors `PresignRequestDto` (the unified `/uploads/presign`
// route) so these routes get the same up-front over-cap reject and pinned
// `ContentLength` — without it, `StorageService.presignImageUpload` never sees
// a size to check and mints an uncapped presigned URL.
export class PresignUploadDto {
  @IsIn(ALLOWED_IMAGE_TYPES)
  contentType!: string;

  @IsInt()
  @Min(1)
  byteSize!: number;
}
