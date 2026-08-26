import { registerAs } from '@nestjs/config';

/**
 * The server-side pepper the ban-evasion module hashes sign-in identifiers
 * with, read the same way every other secret in this codebase is read: a
 * `registerAs` namespace over `process.env` (see `src/config/push.config.ts`,
 * `src/config/auth.config.ts`).
 *
 * Registered through `ConfigModule.forFeature` in `BanEvasionModule` rather
 * than added to the root `load` array, so the module stays self-contained.
 *
 * There is deliberately NO fallback value. An unset `BAN_EVASION_PEPPER` leaves
 * `pepper` undefined and the module writes NULL hashes and scores no identifier
 * signal, which is the safe failure: a weak digest of an email address is worse
 * than no digest at all. Inviter-lineage signals keep working either way.
 *
 * Rotating the pepper invalidates every stored hash (old rows stop matching new
 * applicants). Treat it as write-once for the life of the deployment.
 */
export default registerAs('banEvasion', () => ({
  pepper: process.env.BAN_EVASION_PEPPER,
}));
