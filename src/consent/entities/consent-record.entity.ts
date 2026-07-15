import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum ConsentSource {
  Banner = 'banner',
  PreferenceCenter = 'preference_center',
  SettingsPane = 'settings_pane',
}

export enum ConsentAction {
  Granted = 'granted',
  Updated = 'updated',
  Withdrawn = 'withdrawn',
}

// Append-only, versioned consent log: every POST /consent inserts a NEW row.
// There is deliberately no unique constraint on (user_id, ...) — history is
// preserved so the exact policy version consented to at each moment is auditable.
// `necessary` is always true (session/CSRF cookies, theme/i18n prefs) and is not
// persisted; it is re-synthesised as `true` on every read.
@Entity('consent_record')
export class ConsentRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_consent_record_user_id')
  @Column({ type: 'uuid' })
  userId: string;

  // Pre-auth analytics id echoed from the client, when present. Lets a consent
  // decision be correlated to anonymous activity that preceded sign-in.
  @Column({ type: 'varchar', nullable: true })
  anonId: string | null;

  @Column({ type: 'boolean' })
  analytics: boolean;

  @Column({ type: 'boolean' })
  monitoring: boolean;

  @Column({ type: 'varchar' })
  policyVersion: string;

  @Column({
    type: 'enum',
    enum: ConsentSource,
    enumName: 'consent_record_source_enum',
  })
  source: ConsentSource;

  @Column({
    type: 'enum',
    enum: ConsentAction,
    enumName: 'consent_record_action_enum',
  })
  action: ConsentAction;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
