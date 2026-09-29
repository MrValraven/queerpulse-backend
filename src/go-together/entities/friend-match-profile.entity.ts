import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { FriendMatchAnswers } from '../go-together-questionnaire.catalog';

/**
 * A member's Go together questionnaire. One row per member, keyed by user id.
 * Holding a row at all is special-category data on a queer platform (GDPR Art.
 * 9), so `consentedAt` records the explicit consent given on first save, and
 * deleting the row is how a member withdraws it.
 */
@Entity('friend_match_profiles')
export class FriendMatchProfile {
  @PrimaryColumn({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'jsonb' })
  answers!: FriendMatchAnswers;

  @Column({ type: 'int' })
  questionnaireVersion!: number;

  @Column({ type: 'timestamptz' })
  consentedAt!: Date;

  /** The last opt-in that used these answers. Retention deletes a profile 12
   *  months after the later of this and `updatedAt`. */
  @Column({ type: 'timestamptz', nullable: true })
  lastUsedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
