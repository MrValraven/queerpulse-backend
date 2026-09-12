import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One retired "Now" status. Written by `ProfilesService.updateMe` when a
 * member replaces the status they were carrying, so the card can show what
 * came before without asking them to keep a diary.
 *
 * OWNER-ONLY by construction: no endpoint returns these rows to anyone but
 * the member they belong to, and they are absent from every profile
 * response.
 */
@Index('IDX_profile_now_history_user_ended', ['userId', 'endedAt'])
@Entity('profile_now_history')
export class ProfileNowHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'text' })
  text!: string;

  // When the member started carrying this status. Falls back to the
  // profile's creation date for a status written before `now_updated_at`
  // existed.
  @Column({ type: 'timestamptz' })
  startedAt!: Date;

  @Column({ type: 'timestamptz' })
  endedAt!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
