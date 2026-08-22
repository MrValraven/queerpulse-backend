import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import { catchError, Observable, throwError } from 'rxjs';
import { GeocoderBusyException } from './nominatim-rate-limiter';

/**
 * Puts a real `Retry-After` on the 503 the outbound-geocoder queue raises, so
 * a client backs off by the amount the queue actually needs instead of
 * guessing. Written as an interceptor rather than an exception filter on
 * purpose: it only needs to add a header and hand the error straight back to
 * the global `AllExceptionsFilter`, which owns the one documented error
 * envelope this API returns. A filter would have to re-render that body.
 */
@Injectable()
export class RetryAfterInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        if (error instanceof GeocoderBusyException) {
          const response = context.switchToHttp().getResponse<Response>();
          response.setHeader(
            'Retry-After',
            String(Math.max(1, error.retryAfterSeconds)),
          );
        }
        return throwError(() => error);
      }),
    );
  }
}
