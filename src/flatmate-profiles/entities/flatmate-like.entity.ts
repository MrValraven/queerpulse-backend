import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** A member's one-at-a-time decision in the optional swipe/browse discovery
 * view. `like` and `pass` are both recorded so a passed profile drops out of the
 * viewer's deck. There is no ranking, exposure, or notification implied — a
 * `like` is only ever surfaced to the other member as a *mutual* match. */
export enum FlatmateLikeDecision {
  Like = 'like',
  Pass = 'pass',
}

/**
 * One directed like/pass from a member (`fromUserId`) toward a flatmate profile
 * (`toProfileId`). At most one row per (member, profile) — re-deciding upserts.
 * A mutual match exists when both members have a `like` pointing at each other's
 * profile; that (and only that) can start a hello.
 */
@Entity('flatmate_likes')
@Index('UQ_flatmate_likes_from_to', ['fromUserId', 'toProfileId'], {
  unique: true,
})
export class FlatmateLike {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The member making the decision. Plain uuid (no FK), matching the
   * `flatmate_profiles.owner_id` convention in this module. */
  @Column({ type: 'uuid' })
  fromUserId!: string;

  /** The flatmate profile being decided on (`flatmate_profiles.id`). */
  @Index('IDX_flatmate_likes_to_profile_id')
  @Column({ type: 'uuid' })
  toProfileId!: string;

  @Column({
    type: 'enum',
    enum: FlatmateLikeDecision,
    enumName: 'flatmate_likes_decision_enum',
  })
  decision!: FlatmateLikeDecision;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
