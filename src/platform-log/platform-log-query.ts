import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import type { PlatformLogRange, SourceWindow } from './platform-log.types';

const EXACT_TIME_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const DAY_MS = 86_400_000;

/** A timestamp column as a fixed-format microsecond UTC string. */
export function exactTimeSql(columnSql: string): string {
  return `to_char(${columnSql} AT TIME ZONE 'UTC', ${EXACT_TIME_FORMAT})`;
}

/** A row id as text under byte ordering, so SQL and JS agree on tie order. */
export function rowIdTextSql(columnSql: string): string {
  return `CAST(${columnSql} AS text) COLLATE "C"`;
}

export interface PlatformLogKeysetColumns {
  /** Quoted column, e.g. `"e"."created_at"`. */
  timeSql: string;
  /** Quoted column, e.g. `"e"."id"`. */
  idSql: string;
}

/** `{ alias: sql }` into one `select` plus `addSelect`s, in order. */
export function selectPlatformLogColumns<Entity extends ObjectLiteral>(
  queryBuilder: SelectQueryBuilder<Entity>,
  columns: Record<string, string>,
): SelectQueryBuilder<Entity> {
  let isFirstColumn = true;
  for (const [alias, sql] of Object.entries(columns)) {
    if (isFirstColumn) {
      queryBuilder.select(sql, alias);
      isFirstColumn = false;
    } else {
      queryBuilder.addSelect(sql, alias);
    }
  }
  return queryBuilder;
}

/**
 * Keyset window shared by every source. Entries are ordered by
 * `(time, sourceKey, rowId)` descending across the whole log, so a source
 * whose key sorts below the cursor's may still return rows AT the cursor time,
 * a source above it may not, and the cursor's own source breaks ties by row id.
 */
export function applyPlatformLogWindow<Entity extends ObjectLiteral>(
  queryBuilder: SelectQueryBuilder<Entity>,
  sourceKey: string,
  columns: PlatformLogKeysetColumns,
  window: SourceWindow,
): SelectQueryBuilder<Entity> {
  const rowIdText = rowIdTextSql(columns.idSql);
  const cursorTime = 'CAST(:platformLogCursorTime AS timestamptz)';
  const { cursor } = window;
  if (cursor) {
    const parameters = {
      platformLogCursorTime: cursor.occurredAtExact,
      platformLogCursorRowId: cursor.rowId,
    };
    if (sourceKey < cursor.sourceKey) {
      queryBuilder.andWhere(`${columns.timeSql} <= ${cursorTime}`, parameters);
    } else if (sourceKey > cursor.sourceKey) {
      queryBuilder.andWhere(`${columns.timeSql} < ${cursorTime}`, parameters);
    } else {
      queryBuilder.andWhere(
        `(${columns.timeSql} < ${cursorTime} OR ` +
          `(${columns.timeSql} = ${cursorTime} AND ` +
          `${rowIdText} < :platformLogCursorRowId))`,
        parameters,
      );
    }
  }
  if (window.since) {
    queryBuilder.andWhere(`${columns.timeSql} >= :platformLogSince`, {
      platformLogSince: window.since,
    });
  }
  return queryBuilder
    .orderBy(columns.timeSql, 'DESC')
    .addOrderBy(rowIdText, 'DESC')
    .limit(window.limit + 1);
}

/** Keeps only non-empty string values. */
export function compactParams(
  values: Record<string, string | null | undefined>,
): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    if (value) params[name] = value;
  }
  return params;
}

export function sinceForRange(range: PlatformLogRange, now: Date): Date | null {
  switch (range) {
    case 'today':
      return new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
      );
    case 'week':
      return new Date(now.getTime() - 7 * DAY_MS);
    case 'month':
      return new Date(now.getTime() - 30 * DAY_MS);
    case 'quarter':
      return new Date(now.getTime() - 90 * DAY_MS);
    case 'all':
      return null;
  }
}
