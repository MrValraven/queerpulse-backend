import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A member's per-category notification override. **Sparse**: a row exists only
 * for a category a member has explicitly turned off (or partially off) — the
 * absence of a row means "default", which is ON for both channels. So a member
 * who never touches settings has zero rows and gets everything, exactly as
 * before this table existed. The service deletes the row again when a category
 * returns to the all-ON default, keeping the table sparse.
 *
 * Keyed `(user_id, category)`: one row per member per toggle. `category` is a
 * plain string holding a `NotificationPreferenceCategory` value (validated by
 * the DTO), not a Postgres enum — new categories are then code-only.
 */
@Entity('notification_preferences')
export class NotificationPreference {
  @PrimaryColumn({ type: 'uuid' })
  userId!: string;

  @PrimaryColumn({ type: 'varchar', length: 64 })
  category!: string;

  /** Whether the bell/in-app notification is delivered for this category. */
  @Column({ type: 'boolean', default: true })
  inApp!: boolean;

  /** Whether a phone push is delivered for this category. */
  @Column({ type: 'boolean', default: true })
  push!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
