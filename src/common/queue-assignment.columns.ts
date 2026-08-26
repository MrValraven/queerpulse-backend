import { Column } from 'typeorm';

/**
 * The two clocks every staff queue needs: WHO is working this row, and WHEN it
 * should have been answered by (OPS-04).
 *
 * Until this existed, exactly one queue on the platform had either concept.
 * `reports` carries `assigned_moderator_id`/`assigned_at`/`sla_due_at` and the
 * moderation console is built on them: claim, release, "Assigned to me", an
 * overdue badge. Invite requests, verification requests, intakes and partner
 * applications had none of it, so with two people on the rota every one of
 * those queues was either double-worked or not worked at all, and nothing ever
 * went red on age.
 *
 * WHY AN ABSTRACT BASE ENTITY, NOT AN EMBEDDED COLUMN. TypeORM offers both.
 * An embedded (`@Column(() => QueueAssignment)`) would prefix every physical
 * column with the property name (`assignment_assigned_staff_id`), which reads
 * badly in SQL, cannot be turned off per-entity without a `prefix: false` on
 * each site anyway, and would make the four tables disagree with `reports`,
 * whose columns are flat. Concrete-table inheritance (this) gives all four
 * tables the SAME three flat column names, so a query written against one
 * queue reads identically against the next, and applying it to an entity is a
 * single `extends` on the class line. That last point matters here: two of the
 * four entity files were being edited concurrently, and a one-line, uniquely
 * anchored change is the only safe kind.
 *
 * NO `@Index` LIVES HERE, deliberately. An index name is global in Postgres,
 * so a named index declared on this base would be emitted four times under one
 * name and collide. Each concrete entity declares its own class-level
 * `@Index('IDX_<table>_assigned_staff_id', ['assignedStaffId'])` — and only
 * where the queue actually filters on it, which is why `intake_submissions`
 * and `partners` have none.
 *
 * NO FOREIGN KEY LIVES HERE EITHER: `assignedStaffId` is a plain uuid column
 * with the FK declared in the migration (`ON DELETE SET NULL`), matching how
 * `reports.assigned_moderator_id`, `intake_submissions.reviewed_by_id` and
 * `join_requests.reviewed_by` are all already done in this repo. A staff
 * erasure therefore reverts the row to unassigned rather than blocking the
 * erasure sweep.
 */
export abstract class QueueAssignmentColumns {
  /**
   * The staff member currently working this row. NULL means unassigned, which
   * is both the initial state and where an erased account's rows land.
   */
  @Column({ type: 'uuid', nullable: true })
  assignedStaffId!: string | null;

  /**
   * Set together with `assignedStaffId`, cleared together on release — the
   * same claim-watermark pattern `reports.assigned_at` uses.
   */
  @Column({ type: 'timestamptz', nullable: true })
  assignedAt!: Date | null;

  /**
   * When this row should have been answered by, computed once at creation from
   * whatever that queue's own window is (each queue owns a `*-sla.ts` holding
   * its named constants). Never recomputed: a due date that moved every time
   * someone touched the row would not be a promise.
   *
   * NULL means NO CLOCK, never "overdue". Rows created before this column
   * existed and already decided keep NULL, and every read path treats that as
   * "nothing to say" rather than inventing a breach.
   *
   * Millisecond precision, like `reports.sla_due_at`: Postgres defaults to
   * microseconds, a JS `Date` carries milliseconds, and any future keyset over
   * this column would re-serve its boundary row on the next page if the stored
   * value had a sub-millisecond tail the cursor could not express.
   */
  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  dueAt!: Date | null;
}
