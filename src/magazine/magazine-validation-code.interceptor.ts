import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, catchError, throwError } from 'rxjs';
import { VALIDATION_CODE_SEPARATOR } from './magazine-error-codes';

/**
 * A code at the front of a constraint message: `SCREAMING_SNAKE: sentence`.
 * Built from the separator `codedValidationMessage` writes (plain text, no
 * regex metacharacters) so the two cannot drift apart.
 */
const CODED_MESSAGE_PATTERN = new RegExp(
  `^([A-Z][A-Z0-9_]*)${VALIDATION_CODE_SEPARATOR}([\\s\\S]*)$`,
);

/**
 * Gives a DTO validation failure on a magazine route the same `code` field
 * every other magazine refusal carries.
 *
 * The global `ValidationPipe` answers a failed DTO with
 * `{ statusCode: 400, error: 'Bad Request', message: string[] }` and drops
 * everything about each constraint except its message, so the coded DTOs put
 * the code at the front of the message (`codedValidationMessage`). Pipes run
 * inside the interceptor chain (`RouterExecutionContext` applies them in the
 * handler the interceptors wrap), so this sees that 400 and rewrites it to
 *
 *   { statusCode: 400, error: 'Bad Request',
 *     message: string[],   // the English sentences, code prefix removed
 *     code: string,        // the first coded constraint, in message order
 *     codes: string[] }    // every distinct code, in message order
 *
 * A 400 with no coded message (an uncoded DTO, `forbidNonWhitelisted`, a
 * `ParseUUIDPipe`) and every other error pass through untouched.
 */
@Injectable()
export class MagazineValidationCodeInterceptor implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next
      .handle()
      .pipe(
        catchError((error: unknown) =>
          throwError(() => withValidationCodes(error)),
        ),
      );
  }
}

/**
 * The rewritten exception for a coded validation 400, or `error` itself for
 * anything else. Exported for the spec.
 */
export function withValidationCodes(error: unknown): unknown {
  if (!(error instanceof BadRequestException)) {
    return error;
  }
  const body = error.getResponse();
  if (typeof body !== 'object' || body === null) {
    return error;
  }
  const messages = (body as { message?: unknown }).message;
  if (!Array.isArray(messages)) {
    return error;
  }

  const codes: string[] = [];
  const plainMessages = messages.map((entry: unknown) => {
    if (typeof entry !== 'string') {
      return entry;
    }
    const match = CODED_MESSAGE_PATTERN.exec(entry);
    if (!match) {
      return entry;
    }
    const [, code, sentence] = match;
    if (code === undefined || sentence === undefined) {
      return entry;
    }
    if (!codes.includes(code)) {
      codes.push(code);
    }
    return sentence;
  });
  if (codes.length === 0) {
    return error;
  }

  return new BadRequestException({
    ...body,
    message: plainMessages,
    code: codes[0],
    codes,
  });
}
