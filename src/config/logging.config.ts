import { registerAs } from '@nestjs/config';

/**
 * Pino logging knobs, resolved once here so app.module.ts reads them through
 * ConfigService rather than touching process.env directly. Both inputs
 * (LOG_LEVEL, LOG_PRETTY) are validated in src/config/env.validation.ts.
 */
export default registerAs('logging', () => {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  return {
    level:
      process.env.LOG_LEVEL ?? (nodeEnv === 'production' ? 'info' : 'debug'),
    // pino-pretty is a devDependency and is absent from the production image,
    // so selecting it there throws at boot ("unable to determine transport
    // target") before a logger exists to report why. Keying that off
    // `NODE_ENV !== 'production'` made a boot crash reachable by setting
    // NODE_ENV=staging in a dashboard; require an explicit opt-in instead.
    // LOG_PRETTY=true in a deployed environment is the caller's problem.
    pretty:
      process.env.LOG_PRETTY === 'true' ||
      (process.env.LOG_PRETTY === undefined && nodeEnv === 'development'),
  };
});
