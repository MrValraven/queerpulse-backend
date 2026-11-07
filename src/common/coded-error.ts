/**
 * The body of a coded refusal: a stable machine `code` beside the English
 * `message`, plus any domain fields the caller adds (`pieceId`,
 * `openGateItems`, `currentVersion`, ...).
 *
 * Throw it inside any Nest `HttpException` subclass, which keeps choosing the
 * status:
 *
 *   throw new NotFoundException(codedErrorBody('X_NOT_FOUND', 'X not found'));
 *
 * `AllExceptionsFilter` fills in `statusCode` and `error` on object bodies, so
 * the wire body is always
 *
 *   { statusCode: number, error: string, code: string, message: string,
 *     ...extras }
 *
 * which is the shape the frontend already reads for `PLATFORM_LOCKED`,
 * `COMMUNITY_FROZEN` and the first-contact refusals. `HttpException` also
 * copies a string `message` onto `error.message`, so `toThrow('X not found')`
 * in a spec keeps matching after a site moves to this helper.
 *
 * `code` and `message` always win over a same-named key in `extras`.
 */
export function codedErrorBody<
  Code extends string,
  Extras extends Record<string, unknown> = Record<never, never>,
>(
  code: Code,
  message: string,
  extras?: Extras,
): Extras & { code: Code; message: string } {
  return { ...(extras ?? ({} as Extras)), code, message };
}

/**
 * Machine codes for refusals that come from shared guards, interceptors and
 * the global filter rather than from one feature. Every VALUE is a frozen
 * contract with the frontend classifier (`shared/api/causeErrorKey.ts`).
 */
export const PLATFORM_ERROR_CODE = {
  // `ActiveMemberGuard` and the one handler that restates its check.
  ACTIVE_MEMBERSHIP_REQUIRED: 'ACTIVE_MEMBERSHIP_REQUIRED',
  // Every `CsrfGuard` refusal: the client's answer is the same (reload).
  CSRF_REJECTED: 'CSRF_REJECTED',
  // `StorageKeyOwnershipInterceptor`: the body names an upload the caller does not own.
  UPLOAD_NOT_YOURS: 'UPLOAD_NOT_YOURS',
  // A request body over the parser limit (body-parser's 413).
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
} as const;
