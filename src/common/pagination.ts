import { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

/** Default page size for all list/search endpoints across domains. */
export const PAGE_SIZE = 20;

/**
 * Hard upper bound for list endpoints that intentionally return a whole
 * (unpaginated) array rather than a `Paginated<T>` envelope. Applied as a
 * `take`/`limit` cap so no such query can ever return an unbounded result set,
 * without changing the response shape callers already depend on. Sized well
 * above every current real-world list so existing callers behave identically.
 */
export const DEFAULT_LIST_LIMIT = 200;

/**
 * Hard upper bound for the `page` query parameter on every paginated list
 * endpoint (ENG-49). `limit`/`pageSize` were capped everywhere and `page` was
 * not, so `?page=2000000000` became an `OFFSET 39999999980` scan that Postgres
 * has to walk row by row before discarding: free today at small row counts, and
 * a cheap unauthenticated way to pin a CPU once any listed table is large.
 *
 * 10_000 pages at `PAGE_SIZE` is 200_000 rows deep, far past anything a human
 * reaches by clicking "next", so no real caller can hit it. A client that wants
 * to walk a whole table should narrow its filter, not deepen its offset.
 */
export const MAX_PAGE = 10_000;

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Coerces an arbitrary (possibly absent/invalid) page number to >= 1. */
export function normalizePage(page?: number): number {
  return page && page > 0 ? page : 1;
}

/**
 * Runs `qb` with `PAGE_SIZE`-based offset pagination, maps the raw rows to
 * `T` via `map` (sync or async), and returns the `{items,total,page,pageSize}`
 * envelope used by every list endpoint (mirrors
 * `ProfilesService.searchMembers`).
 *
 * `page` is expected to already be normalized (see `normalizePage`); callers
 * own that so this function stays a pure "fetch + shape" step.
 */
export async function paginate<E extends ObjectLiteral, T>(
  qb: SelectQueryBuilder<E>,
  page: number,
  map: (rows: E[]) => Promise<T[]> | T[],
): Promise<Paginated<T>> {
  const [rows, total] = await qb
    .skip((page - 1) * PAGE_SIZE)
    .take(PAGE_SIZE)
    .getManyAndCount();

  return {
    items: await map(rows),
    total,
    page,
    pageSize: PAGE_SIZE,
  };
}
