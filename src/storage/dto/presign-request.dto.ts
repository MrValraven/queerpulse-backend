import { IsIn, IsInt, Min } from 'class-validator';
import { ALLOWED_IMAGE_TYPES } from '../upload-content-types';
import { UPLOAD_KINDS, UploadKind } from '../upload-kinds';

// Body for the unified `POST /uploads/presign`. `byteSize` lets the server
// reject an over-cap upload before minting a signature (see
// `queerpulse/src/features/members/api/uploads.api.ts` for the canonical
// frontend contract this mirrors).
export class PresignRequestDto {
  @IsIn(UPLOAD_KINDS)
  kind: UploadKind;

  @IsIn(ALLOWED_IMAGE_TYPES)
  contentType: string;

  @IsInt()
  @Min(1)
  byteSize: number;
}
