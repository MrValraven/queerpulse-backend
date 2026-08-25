import type { LoggerService } from '@nestjs/common';

/**
 * Nest's bootstrap loggers, identified by the context string each one binds.
 *
 * These three emit ONE line per unit of wiring as the app initializes:
 *   - InstanceLoader:   one per module        ("X dependencies initialized")
 *   - RoutesResolver:   one per controller    ("XController {/v1/x}:")
 *   - RouterExplorer:   one per route handler ("Mapped {/v1/x, GET} route")
 *
 * At this app's size that is roughly 100 + 155 + 775 ≈ 1,030 lines, all of them
 * at `log`/info level, all emitted synchronously inside `app.listen()` in well
 * under a second. Railway drops anything past 500 logs/sec PER REPLICA and
 * answers with "Railway rate limit of 500 logs/sec reached for replica", so
 * every single deploy burned the whole budget on a route table nobody reads,
 * and roughly 600 lines were dropped on the floor. Worse, the dropping is
 * indiscriminate: a genuine startup warning (a pending migration from
 * ensure-database-schema, a failed boot) is exactly as likely to be discarded
 * as a "Mapped ... route" line.
 *
 * Filtering by CONTEXT rather than by level is deliberate. These lines are
 * `log`-level, so the only level-based lever is raising LOG_LEVEL to `warn`,
 * which would also silence the application's own info logging and every
 * pino-http request line. Their context is stable across Nest versions (it is
 * the class name, bound at construction in @nestjs/core), so this is a narrow
 * cut with nothing else caught in it.
 */
const BOOT_NOISE_CONTEXTS: ReadonlySet<string> = new Set([
  'InstanceLoader',
  'RoutesResolver',
  'RouterExplorer',
]);

/**
 * Nest's `Logger` appends its bound context as the LAST optional param before
 * delegating to the registered LoggerService (see @nestjs/common's
 * logger.service.js, `optionalParams.concat(this.context)`), so the context is
 * read off the tail rather than from a named argument.
 */
function isBootNoise(optionalParams: unknown[]): boolean {
  const context = optionalParams.at(-1);
  return typeof context === 'string' && BOOT_NOISE_CONTEXTS.has(context);
}

/**
 * Wrap a LoggerService so Nest's per-module/controller/route boot chatter is
 * dropped, and everything else passes through untouched.
 *
 * Scope is intentionally minimal: ONLY `log()` is filtered, and only for the
 * three contexts above. `warn`/`error`/`fatal` are never filtered by anything,
 * including for those contexts. A RouterExplorer *error* is a real wiring
 * failure and must survive. "Nest application successfully started" is bound to
 * the `NestApplication` context, so it is not in the cut and still prints.
 */
export function withQuietBootLogging(delegate: LoggerService): LoggerService {
  const quiet: LoggerService = {
    log(message: unknown, ...optionalParams: unknown[]): void {
      if (isBootNoise(optionalParams)) return;
      delegate.log(message, ...optionalParams);
    },
    warn(message: unknown, ...optionalParams: unknown[]): void {
      delegate.warn(message, ...optionalParams);
    },
    error(message: unknown, ...optionalParams: unknown[]): void {
      delegate.error(message, ...optionalParams);
    },
  };

  // `fatal`/`debug`/`verbose`/`setLogLevels` are optional on LoggerService.
  // Forward each only when the delegate actually implements it, so the wrapper
  // reports the same capabilities as what it wraps. Defining them
  // unconditionally would make Nest believe a level is supported and call into
  // an undefined method.
  if (delegate.fatal) {
    quiet.fatal = (message: unknown, ...optionalParams: unknown[]): void => {
      delegate.fatal?.(message, ...optionalParams);
    };
  }
  if (delegate.debug) {
    quiet.debug = (message: unknown, ...optionalParams: unknown[]): void => {
      delegate.debug?.(message, ...optionalParams);
    };
  }
  if (delegate.verbose) {
    quiet.verbose = (message: unknown, ...optionalParams: unknown[]): void => {
      delegate.verbose?.(message, ...optionalParams);
    };
  }
  if (delegate.setLogLevels) {
    quiet.setLogLevels = (levels) => {
      delegate.setLogLevels?.(levels);
    };
  }

  return quiet;
}
