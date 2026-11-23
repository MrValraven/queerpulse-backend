import { IsString, MaxLength } from 'class-validator';

/**
 * Body for `POST /uploads/confirm` (SEC-43): the bare storage key a presign
 * returned, sent after the bytes were PUT. The global
 * `StorageKeyOwnershipInterceptor` refuses a key the caller does not own
 * before the handler runs, and the handler checks it again.
 */
export class ConfirmUploadDto {
  @IsString()
  @MaxLength(512)
  key!: string;
}
