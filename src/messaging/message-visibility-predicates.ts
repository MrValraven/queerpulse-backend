/**
 * SQL fragments that decide whether a message row is visible, shared by every
 * query builder that lists, counts or searches messages. Before this file each
 * service carried its own verbatim copy of the takedown predicate, and a copy
 * that drifts from the others shows a taken-down message on one surface only.
 */

/** `content_moderation.subject_type` for a message takedown row. */
export const MESSAGE_SUBJECT_TYPE = 'message';

/**
 * A `NOT EXISTS` fragment that is TRUE only when no moderator has hidden or
 * removed the message aliased `messageAlias`. The caller binds
 * `:messageSubjectType` to {@link MESSAGE_SUBJECT_TYPE}.
 */
export function notModeratedMessagePredicate(messageAlias: string): string {
  return `NOT EXISTS (
      SELECT 1 FROM "content_moderation" "cm"
      WHERE "cm"."subject_type" = :messageSubjectType
        AND "cm"."subject_id" = ${messageAlias}.id::text
        AND ("cm"."hidden_at" IS NOT NULL OR "cm"."removed_at" IS NOT NULL)
    )`;
}
