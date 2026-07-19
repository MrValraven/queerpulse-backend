import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * An immutable record of one field changing on `platform_settings`. A single
 * PATCH that flips two switches writes two rows — the unit of audit is the
 * field, not the request, because "who turned lockdown on" should not require
 * diffing a JSON blob that also happens to mention a message edit.
 */
@Entity('platform_setting_changes')
export class PlatformSettingChange {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Nullable with ON DELETE SET NULL, matching `ModAuditLog` since
  // `AddDeletionErasureSupport1782800700000`: the trail must survive erasure of
  // the account that wrote it. An audit log that vanishes with its author is
  // not an audit log. Always non-null at write time.
  @Index('IDX_platform_setting_changes_actor_id')
  @Column({ type: 'uuid', nullable: true })
  actorId: string | null;

  /** e.g. `lockdownEnabled`. One of `TOGGLEABLE_KEYS`. */
  @Column({ type: 'varchar' })
  settingKey: string;

  /** Stringified previous value; null when the previous value was null. */
  @Column({ type: 'text', nullable: true })
  oldValue: string | null;

  /** Stringified new value; null when the new value is null. */
  @Column({ type: 'text', nullable: true })
  newValue: string | null;

  /** Optional note the admin supplied with the change. */
  @Column({ type: 'text', nullable: true })
  note: string | null;

  // Indexed: the history list is always "newest first".
  @Index('IDX_platform_setting_changes_created_at')
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
