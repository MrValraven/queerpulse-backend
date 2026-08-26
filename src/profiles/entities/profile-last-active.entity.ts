import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * A member's coarse "recently active" signal, one row per member who has held a
 * live session since the feature shipped.
 *
 * ITS OWN TABLE, NOT A COLUMN ON `profiles`, for one reason worth keeping: the
 * profile row is hand-mapped into half a dozen response shapes, and a member's
 * activity is the one field on this platform where an accidental leak is a
 * safety problem rather than an aesthetic one. Living here, it can only ever
 * reach a response that went looking for it.
 *
 * SPARSE ON PURPOSE. There is no backfill and no row for a member who has not
 * signed in since the column existed. "No row" is a real state that the read
 * path renders as nothing at all, distinct from `Dormant`. See
 * `bandFor` in ../last-active.ts.
 *
 * NOTE WHAT IS ABSENT: no `created_at`, no `updated_at`, no `last_seen_at`. An
 * `@UpdateDateColumn` here would quietly restore the precise last-seen
 * timestamp this whole design exists to avoid, one row-version at a time.
 */
@Entity('profile_last_active')
export class ProfileLastActive {
  /** PK and FK to `users.id` (ON DELETE CASCADE, declared in the migration). */
  @PrimaryColumn({ type: 'uuid' })
  userId!: string;

  /**
   * The first day of the month the member last held a live session, e.g.
   * `2026-08-01`. A `date`, so TypeORM hands it back as the `YYYY-MM-DD`
   * string the pure helpers in ../last-active.ts reason about, with no
   * timezone to shift it. A DB CHECK constraint pins it to day 1, so no write
   * path can smuggle a finer value in.
   */
  @Column({ type: 'date' })
  lastActiveMonth!: string;

  /**
   * The member's opt-out. When true, their band is hidden from every other
   * member and they carry no ordering value in the "Recently active" directory
   * sort. They still see their own band on their own profile.
   */
  @Column({ type: 'boolean', default: false })
  isHidden!: boolean;
}
