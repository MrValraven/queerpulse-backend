import { registerAs } from '@nestjs/config';

/**
 * The reports module's own configuration namespace, read the way every other
 * secret in this codebase is read: a `registerAs` namespace over `process.env`
 * (see `ban-evasion/ban-evasion.config.ts`, `config/auth.config.ts`).
 * Registered through `ConfigModule.forFeature` in `ReportsModule` rather than
 * added to the root `load` array, so the module stays self-contained.
 *
 * `anonymousFloodPepper` is the HMAC key `anonymous-reporter-key.ts` derives a
 * signed-out reporter's durable flood-cap key with. It is a pepper and not a
 * salt: the whole point is that the digests on the `reports` table cannot be
 * walked back to the addresses they came from by anyone holding the table,
 * and the IPv4 space is small enough that an unkeyed hash would be reversible
 * in seconds.
 *
 * UNSET IS NOT UNCAPPED. Unlike `BAN_EVASION_PEPPER`, whose absence disables a
 * signal, this one has a fallback: `ReportsService` generates a random pepper
 * once per process and warns. The anonymous caps then still bind, but only for
 * the life of the process, because a restart makes every previously stored key
 * unmatchable. That is the same durability the burst `@Throttle` has and it is
 * the honest degradation for an anti-abuse control: a cap that quietly stopped
 * existing because an operator missed an environment variable would be worse
 * than one that resets on deploy. Set it in production.
 *
 * Rotating it has exactly that effect on purpose: every stored key stops
 * matching, so the anonymous window empties. Treat it as write-once for the
 * life of the deployment.
 */
export default registerAs('reports', () => ({
  anonymousFloodPepper: process.env.REPORT_ANONYMOUS_FLOOD_PEPPER,
}));
