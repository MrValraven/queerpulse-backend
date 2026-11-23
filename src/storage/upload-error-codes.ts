import { HttpException, HttpStatus } from '@nestjs/common';
import { codedErrorBody } from '../common/coded-error';

/**
 * Machine codes for the upload refusals this module adds (SEC-43, SEC-44).
 * Every VALUE is a contract with the frontend classifier
 * (`shared/api/causeErrorKey.ts`), which maps each one to its own copy line.
 */
export const UPLOAD_ERROR_CODE = {
  // SEC-44: the member has presigned their whole daily byte allowance.
  UPLOAD_DAILY_QUOTA_REACHED: 'UPLOAD_DAILY_QUOTA_REACHED',
  // SEC-43: a JPEG whose EXIF still carries a GPS block.
  UPLOAD_HAS_LOCATION_DATA: 'UPLOAD_HAS_LOCATION_DATA',
  // The uploaded bytes do not match the type the upload declared.
  UPLOAD_CONTENT_MISMATCH: 'UPLOAD_CONTENT_MISMATCH',
  // Nothing was stored under the key (the PUT did not land).
  UPLOAD_NOT_FOUND: 'UPLOAD_NOT_FOUND',
  // The storage check could not run (a transient bucket or network error);
  // trying again is the answer.
  UPLOAD_CHECK_UNAVAILABLE: 'UPLOAD_CHECK_UNAVAILABLE',
  // `POST /uploads/confirm` was sent a key that names no uploader.
  UPLOAD_KEY_NOT_CONFIRMABLE: 'UPLOAD_KEY_NOT_CONFIRMABLE',
  // A write body carried more photo references than one request may verify.
  UPLOAD_TOO_MANY_REFERENCES: 'UPLOAD_TOO_MANY_REFERENCES',
} as const;

/** SEC-44: the 429 a presign answers once the daily allowance is spent. */
export function uploadDailyQuotaReached(limitBytes: number): HttpException {
  return new HttpException(
    codedErrorBody(
      UPLOAD_ERROR_CODE.UPLOAD_DAILY_QUOTA_REACHED,
      'You have reached the daily upload limit for your account',
      { limitBytes },
    ),
    HttpStatus.TOO_MANY_REQUESTS,
  );
}
