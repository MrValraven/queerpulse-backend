import { Injectable, Logger } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

// Reads the session if there is one, but never rejects. `FilesController` needs
// to know *whether* a member is logged in without 401ing the public kinds, and
// Passport's default `handleRequest` throws on a missing or invalid token.
//
// This reuses the existing `JwtStrategy` — same cookie extractor, same
// per-request DB status/role check — rather than parsing the token a second way.
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(OptionalJwtAuthGuard.name);

  handleRequest<TUser>(error: unknown, user: TUser): TUser | null {
    // Still returns null on any error rather than throwing — a bad/missing
    // token must fall through to the public kinds, not 401 or 500 the whole
    // route. But swallowing it silently made an infrastructure failure (e.g.
    // JwtStrategy.validate's DB check throwing on an outage) indistinguishable
    // from "not logged in": gathering-photos would read as a 401 permissions
    // bug instead of the 500 database incident it actually is. Logging keeps
    // the behavior (anonymous fallback) while making the cause visible.
    if (error) {
      this.logger.error(
        'JWT validation errored; treating request as anonymous',
        error instanceof Error ? error.stack : error,
      );
    }
    return user || null;
  }
}
