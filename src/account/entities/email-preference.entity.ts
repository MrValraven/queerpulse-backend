import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

// One row per (user, category) email-notification toggle. A category with no
// stored row falls back to `AccountService`'s default matrix — this table
// only holds overrides, not the full always-present set of categories.
@Entity('email_preference')
@Unique('UQ_email_preference_user_id_category', ['userId', 'category'])
export class EmailPreference {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_email_preference_user_id')
  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar' })
  category: string;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
