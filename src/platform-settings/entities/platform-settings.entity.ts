import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * The one and only row's primary key. The table carries a CHECK (id = 1)
 * constraint, so there is physically no second row to disagree with this one —
 * a settings table that can hold two rows eventually holds two rows, and then
 * "is the platform locked?" has two answers.
 */
export const PLATFORM_SETTINGS_ID = 1;

/**
 * Runtime platform kill switches, editable by admins from the dashboard.
 *
 * The row is INSERTed by `AddPlatformSettings1782800790000`, so no code path
 * has to handle its absence — if it is missing, the migration did not run and
 * that is a deployment fault worth failing loudly on, not a case to default
 * around. Defaulting a missing row to "unlocked" would mean a database problem
 * silently disables the kill switch.
 */
@Entity('platform_settings')
export class PlatformSettings {
  @PrimaryColumn({ type: 'int' })
  id: number;

  /** Gates creation of new `User` rows. Returning users are unaffected. */
  @Column({ type: 'boolean', default: true })
  registrationEnabled: boolean;

  /** Gates `POST /join-requests`, the public "request an invite" form. */
  @Column({ type: 'boolean', default: true })
  joinRequestsEnabled: boolean;

  /** The platform kill switch: blocks everyone except staff. */
  @Column({ type: 'boolean', default: false })
  lockdownEnabled: boolean;

  /** Whether moderators are staff for the purposes of the switch above. */
  @Column({ type: 'boolean', default: false })
  lockdownAllowsModerators: boolean;

  /** Admin-authored copy shown on the maintenance screen. */
  @Column({ type: 'text', nullable: true })
  lockdownMessage: string | null;

  /**
   * Shared by BOTH the registration and join-request closed states — the two
   * flags are independent switches but describe the same situation to the same
   * audience, so they deliberately do not get separate copy.
   */
  @Column({ type: 'text', nullable: true })
  registrationClosedMessage: string | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  // NULLable + ON DELETE SET NULL: the stamp outlives an erased admin.
  @Column({ type: 'uuid', nullable: true })
  updatedBy: string | null;
}
