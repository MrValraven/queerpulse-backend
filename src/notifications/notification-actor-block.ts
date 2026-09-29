import { FindOperator, Raw } from 'typeorm';
import { ACTOR_PAYLOAD_KEY } from './notification-response';

/** The bound parameter carrying the reader's user id into the predicate. */
export const ACTOR_BLOCK_READER_PARAMETER = 'actorBlockReaderUserId';

/**
 * The SQL expression naming a row's acting member, as text: the per-type
 * payload key `ACTOR_PAYLOAD_KEY` lists (the same key `actorIdOf` reads for
 * display), grouped so each distinct key costs one `WHEN` arm. A type with
 * no entry yields NULL, so a system row is never hidden by a block.
 *
 * The type is compared as `::text` so a type the code knows and the database
 * enum does not yet carry is a harmless non-match, where an enum literal
 * would fail the whole query.
 */
function actorExpression(typeColumn: string, payloadColumn: string): string {
  const typesByPayloadKey = new Map<string, string[]>();
  for (const [type, payloadKey] of Object.entries(ACTOR_PAYLOAD_KEY)) {
    if (!payloadKey) continue;
    const types = typesByPayloadKey.get(payloadKey) ?? [];
    types.push(type);
    typesByPayloadKey.set(payloadKey, types);
  }
  const arms = [...typesByPayloadKey.entries()].map(
    ([payloadKey, types]) =>
      `WHEN (${typeColumn})::text IN (${types
        .map((type) => `'${type}'`)
        .join(', ')}) THEN (${payloadColumn}) ->> '${payloadKey}'`,
  );
  return `(CASE ${arms.join(' ')} END)`;
}

/**
 * PRD-403: the condition every read of a member's own notification rows
 * applies so a row whose actor is blocked EITHER WAY with the reader stays
 * hidden while the block stands. The write-time gate in
 * `NotificationsService.create` stops new rows; this hides the rows written
 * before the block, in the bell (`list`), the badge (`unreadCount`), the
 * mentions inbox and both "mark all read" paths, so the list and the badge
 * share one filter. Nothing is deleted: lifting the block shows the rows
 * again.
 *
 * The block lookup is the either-way shape `BlockFilterService.excludeBlocked`
 * uses, written as an UNCORRELATED subquery (it reads only `blocks` and the
 * reader id), so Postgres evaluates it once per statement and probes the
 * result per row: one block lookup per request, inside the query that pages
 * the rows, so `LIMIT` still counts only visible rows. `COALESCE(..., '')`
 * keeps a row with no actor visible, since `NULL NOT IN (...)` is NULL.
 *
 * Keyed on the `id` column because `payload` already carries the mailbox
 * seat rule and the mentions inbox pins `type`, and a find condition holds
 * one operator per column. The row's own `type` and `payload` are reached
 * through the alias prefix TypeORM hands the generator: `Notification.id` in
 * a find, a bare `id` in an update. TypeORM's property-name pass rewrites
 * both forms to the quoted column, which is why each column reference sits
 * directly inside parentheses.
 *
 * Used as `where: { userId, id: visibleThroughActorBlocks(userId), ... }`.
 */
export function visibleThroughActorBlocks(
  readerUserId: string,
): FindOperator<string> {
  return Raw(
    (idColumn: string) => {
      const aliasPrefix = idColumn.slice(0, idColumn.length - 'id'.length);
      const actor = actorExpression(
        `${aliasPrefix}type`,
        `${aliasPrefix}payload`,
      );
      return `COALESCE(${actor}, '') NOT IN (
        SELECT "__actor_block"."blocked_id"::text FROM "blocks" "__actor_block"
        WHERE "__actor_block"."blocker_id" = :${ACTOR_BLOCK_READER_PARAMETER}
        UNION ALL
        SELECT "__actor_block"."blocker_id"::text FROM "blocks" "__actor_block"
        WHERE "__actor_block"."blocked_id" = :${ACTOR_BLOCK_READER_PARAMETER}
      )`;
    },
    { [ACTOR_BLOCK_READER_PARAMETER]: readerUserId },
  ) as FindOperator<string>;
}
