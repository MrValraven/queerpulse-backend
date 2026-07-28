/**
 * Postgres unique-violation SQLSTATE. Raised whenever an INSERT/UPDATE loses a
 * race against a unique index or constraint (e.g. two concurrent creates of the
 * same slug/handle). Services typically catch it to map to a 409 Conflict or to
 * retry with a freshly-minted value.
 */
export const POSTGRES_UNIQUE_VIOLATION = '23505';

/**
 * True when `error` is a Postgres unique-violation (SQLSTATE 23505) as surfaced
 * by TypeORM.
 *
 * The SQLSTATE turns up in different places depending on how the error was
 * raised: some paths expose it on the top-level object (`error.code`), others
 * nest it on the wrapped driver error (`error.driverError.code`). This checks
 * BOTH shapes so it is correct for every caller — replacing the ~23 hand-rolled
 * copies that each covered only a subset of these shapes.
 *
 * Pass `constraint` to additionally require the violation to be on a specific
 * named unique index/constraint (matched against `error.constraint` or
 * `error.driverError.constraint`) — used to tell apart which unique index lost a
 * create-vs-create race.
 */
export function isUniqueViolation(
  error: unknown,
  constraint?: string,
): boolean {
  const candidate = error as {
    code?: string;
    constraint?: string;
    driverError?: { code?: string; constraint?: string };
  };
  const isUniqueViolationCode =
    candidate?.code === POSTGRES_UNIQUE_VIOLATION ||
    candidate?.driverError?.code === POSTGRES_UNIQUE_VIOLATION;
  if (!isUniqueViolationCode) return false;
  if (!constraint) return true;
  return (
    candidate?.constraint === constraint ||
    candidate?.driverError?.constraint === constraint
  );
}
