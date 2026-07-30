import { ObjectLiteral, Repository } from 'typeorm';

export interface BatchedDeleteOptions {
  /** Maximum rows removed per DELETE statement. */
  batchSize: number;
  /**
   * Safety valve so one scheduled run can never loop forever against a table
   * that keeps producing matches faster than it deletes them. When hit, the run
   * stops early and the next tick continues where it left off.
   */
  maxBatches: number;
}

/**
 * Delete rows matching `whereSql` in bounded batches instead of one unbounded
 * `DELETE`. A single statement over a large table can hold a long lock and bloat
 * the WAL; each batch here removes at most `batchSize` rows, chosen by a
 * primary-key subselect (`DELETE ... WHERE id IN (SELECT id ... LIMIT n)`), which
 * Postgres runs as a keyset-bounded scan.
 *
 * The loop stops as soon as a batch clears fewer than `batchSize` rows (nothing
 * left to remove) or `maxBatches` is reached. It is idempotent and safe to run
 * concurrently: a row already gone simply doesn't match, so an overlapping tick
 * on another replica just deletes whatever remains. Returns the total removed.
 *
 * `whereSql` and `parameters` are the same shape TypeORM's `QueryBuilder.where`
 * accepts; do NOT interpolate user input into `whereSql` — use `:named`
 * parameters. The batch-size parameter name is reserved internally.
 */
export async function deleteInBatches<Entity extends ObjectLiteral>(
  repository: Repository<Entity>,
  whereSql: string,
  parameters: Record<string, unknown>,
  options: BatchedDeleteOptions,
): Promise<number> {
  const tableName = repository.metadata.tableName;
  const primaryColumnMetadata = repository.metadata.primaryColumns[0];
  if (!primaryColumnMetadata) {
    throw new Error(
      `deleteInBatches: entity "${tableName}" has no primary column`,
    );
  }
  const primaryColumn = primaryColumnMetadata.databaseName;
  let totalRemoved = 0;
  for (let batchIndex = 0; batchIndex < options.maxBatches; batchIndex += 1) {
    const result = await repository
      .createQueryBuilder()
      .delete()
      .from(repository.target)
      .where(
        `"${primaryColumn}" IN (SELECT "${primaryColumn}" FROM "${tableName}" WHERE ${whereSql} LIMIT :retentionBatchSize)`,
        { ...parameters, retentionBatchSize: options.batchSize },
      )
      .execute();
    const removed = result.affected ?? 0;
    totalRemoved += removed;
    if (removed < options.batchSize) {
      break;
    }
  }
  return totalRemoved;
}
