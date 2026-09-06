import { IsIn, IsInt, Min } from 'class-validator';
import {
  ALLOWED_DOCUMENT_TYPES,
  ALLOWED_IMAGE_TYPES,
} from '../upload-content-types';
import { UPLOAD_KINDS, UploadKind } from '../upload-kinds';

// Every content type accepted by ANY upload kind through this one endpoint —
// `StorageService.presignImageUpload` re-checks against the narrower
// per-KIND table (image vs. document) once `kind` is known, so this union is
// deliberately permissive at the DTO layer; it only rejects a value neither
// table would ever accept.
const ALLOWED_UPLOAD_CONTENT_TYPES: readonly string[] = [
  ...ALLOWED_IMAGE_TYPES,
  ...ALLOWED_DOCUMENT_TYPES,
];

// Body for the unified `POST /uploads/presign`. `byteSize` lets the server
// reject an over-cap upload before minting a signature (see
// `queerpulse/src/features/members/api/uploads.api.ts` for the canonical
// frontend contract this mirrors).
export class PresignRequestDto {
  @IsIn(UPLOAD_KINDS)
  kind!: UploadKind;

  @IsIn(ALLOWED_UPLOAD_CONTENT_TYPES)
  contentType!: string;

  @IsInt()
  @Min(1)
  byteSize!: number;
}
