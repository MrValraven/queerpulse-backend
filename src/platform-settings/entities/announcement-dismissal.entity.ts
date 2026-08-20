import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * One row per (member, announcement version) who has dismissed the sitewide
 * announcement banner (ADM-25). Deliberately its own table rather than
 * reusing `persona_nudges`: that table's `nudgeKey` is validated against a
 * fixed, enumerated `NUDGE_KEYS` set (`NudgesService.dismiss` 400s on
 * anything else), and the announcement's key is `announcementVersion` — a
 * fresh UUID minted on every content edit, never a fixed list. Forcing that
 * into `persona_nudges` would mean either loosening its validation for every
 * other caller or silently accepting arbitrary keys there.
 *
 * `UQ_announcement_dismissals_user_id_version` makes a dismiss idempotent at
 * the DB level (`ON CONFLICT DO NOTHING`), mirroring `PersonaNudge`. There is
 * no dismissal state for signed-out visitors — they get a `localStorage` flag
 * keyed by the same version instead (see the frontend `AnnouncementBanner`).
 */
@Entity('announcement_dismissals')
@Unique('UQ_announcement_dismissals_user_id_version', [
  'userId',
  'announcementVersion',
])
export class AnnouncementDismissal {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_announcement_dismissals_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  /** The `PlatformSettings.announcementVersion` this dismissal applies to. */
  @Column({ type: 'uuid' })
  announcementVersion!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  dismissedAt!: Date;
}
