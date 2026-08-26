import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ObjectLiteral, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import type { MemberRef } from './member-ref';
import type { QueueAssignmentColumns } from './queue-assignment.columns';

/**
 * The claim/release write shared by every staff queue (OPS-04), lifted
 * verbatim from `ModerationService.setAssignment` so all four queues inherit
 * the property that makes that one safe: the write is a CONDITIONAL UPDATE
 * guarded on the assignment the caller believed it was changing, so two people
 * pressing "Claim" on the same row at the same moment cannot both win.
 *
 * The read-then-write below is NOT the safety mechanism. It exists to produce
 * good errors (a 409 that names the situation, a 403 for releasing someone
 * else's row). The safety mechanism is the `IS NOT DISTINCT FROM` predicate on
 * the UPDATE: if the row moved between the read and the write, `affected` is
 * 0 and the caller gets a 409 telling them to reload.
 */

/** A status column and the values a row may still be CLAIMED in. */
export interface QueueClaimableStatuses {
  /** Physical (snake_case) column name — an UPDATE has no entity alias. */
  column: string;
  /** The queue's open states. A row outside them cannot be claimed. */
  values: readonly string[];
}

export interface SetQueueAssignmentParams<
  Entity extends ObjectLiteral & QueueAssignmentColumns,
> {
  repository: Repository<Entity>;
  /** The row being claimed or released. */
  id: string;
  /** Its assignee as the caller's own read of the row saw it. */
  currentAssigneeId: string | null;
  actorId: string;
  /**
   * Admins can claim over another staff member's hold and release a hold that
   * is not theirs — the same override `ModerationService.setAssignment` gives
   * platform admins, so a queue cannot deadlock on someone who left.
   */
  isAdmin: boolean;
  assign: boolean;
  /** Lowercase noun for the error copy, e.g. `'invite request'`. */
  rowLabel: string;
  /**
   * Applied only when CLAIMING. Releasing is never status-guarded: whatever
   * happened to the row, letting go of it must keep working.
   */
  claimableStatuses?: QueueClaimableStatuses;
}

/**
 * Claims or releases one queue row.
 *
 * @returns `true` when the row was written, `false` when it was already in the
 * requested state and nothing needed to change (idempotent, same as reports).
 * @throws ConflictException when someone else holds the row, or when the row
 * moved underneath the caller.
 * @throws ForbiddenException when releasing a row held by someone else.
 */
export async function setQueueAssignment<
  Entity extends ObjectLiteral & QueueAssignmentColumns,
>({
  repository,
  id,
  currentAssigneeId,
  actorId,
  isAdmin,
  assign,
  rowLabel,
  claimableStatuses,
}: SetQueueAssignmentParams<Entity>): Promise<boolean> {
  if (assign) {
    if (currentAssigneeId === actorId) return false;
    if (currentAssigneeId !== null && !isAdmin) {
      throw new ConflictException(
        `That ${rowLabel} is already assigned to someone else.`,
      );
    }
  } else {
    if (currentAssigneeId === null) return false;
    if (currentAssigneeId !== actorId && !isAdmin) {
      throw new ForbiddenException(
        `Only the assigned reviewer can release that ${rowLabel}.`,
      );
    }
  }

  // The two columns move together, always — a claim without a timestamp, or a
  // release that left one behind, would both be lies about who holds the row.
  // The cast is the one TypeORM makes unavoidable: `QueryDeepPartialEntity` of
  // a still-generic `Entity` cannot be proven to accept a concrete subset of
  // the base's own columns, even though the generic constraint guarantees
  // every `Entity` here has exactly these two.
  const assignment = {
    assignedStaffId: assign ? actorId : null,
    assignedAt: assign ? new Date() : null,
  } as unknown as QueryDeepPartialEntity<Entity>;

  const queryBuilder = repository
    .createQueryBuilder()
    // The target is passed explicitly rather than inferred from the builder's
    // main alias, mirroring `ModerationService.setAssignment`'s
    // `.update(Report)` — this is the form the repo already runs in production.
    .update(repository.target)
    .set(assignment)
    .where('id = :id', { id })
    // `IS NOT DISTINCT FROM` rather than `=`: the expected value is NULL on an
    // unclaimed row, and `NULL = NULL` is NULL, not true.
    .andWhere('assigned_staff_id IS NOT DISTINCT FROM :expectedAssignee', {
      expectedAssignee: currentAssigneeId,
    });

  if (assign && claimableStatuses) {
    queryBuilder.andWhere(
      `"${claimableStatuses.column}" IN (:...claimableStatuses)`,
      { claimableStatuses: [...claimableStatuses.values] },
    );
  }

  const result = await queryBuilder.execute();
  if (!result.affected) {
    throw new ConflictException(
      `That ${rowLabel} changed while you were acting on it. Reload and try again.`,
    );
  }
  return true;
}

/**
 * The assignee's display name for a queue DTO, resolved from a batched
 * `MemberLookup` result.
 *
 * Reproduces `ModAuditService.nameForUserId` exactly, so the four new queues
 * and the moderation queue name the same person the same way:
 *  - a NULL id reads as `'Deleted member'`. `assigned_staff_id` is
 *    `ON DELETE SET NULL`, so this is what an erased reviewer resolves to;
 *  - an id with no profile row reads as the neutral `'Member'` — never their
 *    email, which is normally `select: false` and is not a chosen display
 *    name, and this label is shown to OTHER staff;
 *  - otherwise, the profile's `firstName lastName`.
 *
 * Callers follow the `ModReportDTO` contract: only ask for a name when the row
 * actually has an assignee, and omit the DTO field entirely when it does not.
 * The NULL arm is the defensive one, present so a mapper that does ask cannot
 * print an empty string where a person used to be.
 */
export function queueAssigneeName(
  assignedStaffId: string | null,
  memberRefs: ReadonlyMap<string, MemberRef>,
): string {
  if (!assignedStaffId) return 'Deleted member';
  const ref = memberRefs.get(assignedStaffId);
  if (!ref) return 'Member';
  return `${ref.firstName} ${ref.lastName}`.trim() || 'Member';
}

/** `queueAssigneeName` for a row that may have no assignee at all: returns
 *  `undefined` so a DTO mapper can spread the field away, matching how
 *  `toModReportDTO` omits `assignedModeratorName` on an unclaimed report. */
export function optionalQueueAssigneeName(
  assignedStaffId: string | null,
  memberRefs: ReadonlyMap<string, MemberRef>,
): string | undefined {
  if (!assignedStaffId) return undefined;
  return queueAssigneeName(assignedStaffId, memberRefs);
}
