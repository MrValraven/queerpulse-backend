import { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

/** Default page size for all list/search endpoints across domains. */
export const PAGE_SIZE = 20;

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
